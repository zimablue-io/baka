#!/usr/bin/env node

// scripts/pack.mjs
//
// Build a clean, installable tarball for one of Baka's published packages.
//
//   node scripts/pack.mjs <@baka/protocol|@baka/sdk|@baka/core|@baka/cli|@baka/mcp>
//        [--out <dir>] [--dep-base <prefix>|semver]
//
// The source manifests point at `src/` and at sibling packages as `workspace:*`; the tarball must stand on its own.
// So the published manifest is rewritten:
//   - `publishConfig` is applied over the top level (main, types, exports, type -> the built `dist`) and removed;
//   - devDependencies are dropped: whatever the bundle inlines (the apps inline every @baka/* package) is listed
//     there, never in `dependencies`;
//   - a `workspace:*` dependency on another published package becomes a real reference to that package's tarball:
//     `<prefix>/baka-<name>-<version>.tgz`. The default prefix is `file://<out>`, which is what the pack-and-install
//     checks use; the site build passes the public URL; `--dep-base semver` writes `^<version>` for an npm publish.

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "..")

const args = process.argv.slice(2)
if (args.length < 1) {
	console.error("usage: scripts/pack.mjs <package> [--out <dir>] [--dep-base <prefix>|semver]")
	process.exit(2)
}

const flag = (name) => {
	const i = args.indexOf(name)
	return i >= 0 ? args[i + 1] : undefined
}
const pkgName = args[0]
const outDir = flag("--out") ? resolve(flag("--out")) : join(REPO_ROOT, "dist-tarballs")
// biome-ignore lint/suspicious/noUndeclaredEnvVars: this script is not a turbo task
const depBase = flag("--dep-base") ?? process.env.BAKA_DEP_BASE ?? `file://${outDir}`

/** The packages that are published, and where they live. */
const PACKAGES = {
	"@baka/protocol": "packages/protocol",
	"@baka/sdk": "packages/sdk",
	"@baka/core": "packages/core",
	"@baka/cli": "apps/cli",
	"@baka/mcp": "apps/mcp",
}

/** The file `pnpm pack` writes for a package: `@baka/core` at 0.1.0 is `baka-core-0.1.0.tgz`. */
const tarballName = (name, version) => `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`

if (!(pkgName in PACKAGES)) {
	console.error(`unknown package: ${pkgName} (expected one of ${Object.keys(PACKAGES).join(", ")})`)
	process.exit(2)
}
const pkgDir = join(REPO_ROOT, PACKAGES[pkgName])
if (!existsSync(pkgDir)) {
	console.error(`package directory missing: ${pkgDir}`)
	process.exit(2)
}

// Dist must exist; bail loudly if not.
const distPath = join(pkgDir, "dist", "index.js")
if (!existsSync(distPath)) {
	console.error(`missing build artifact: ${distPath}. run 'pnpm --filter ${pkgName} build' first.`)
	process.exit(2)
}

const pkgJsonPath = join(pkgDir, "package.json")
const src = JSON.parse(readFileSync(pkgJsonPath, "utf-8"))

const published = { ...src, ...(src.publishConfig ?? {}) }
delete published.publishConfig
delete published.devDependencies
delete published.optionalDependencies
delete published.peerDependencies
delete published.scripts

const dependencies = {}
for (const [name, range] of Object.entries(published.dependencies ?? {})) {
	if (!name.startsWith("@baka/")) {
		dependencies[name] = range
		continue
	}
	if (!(name in PACKAGES)) {
		console.error(
			`${pkgName} depends on ${name}, which is not a published package: list it in devDependencies so the bundle inlines it`,
		)
		process.exit(2)
	}
	const dir = join(REPO_ROOT, PACKAGES[name])
	const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"))
	dependencies[name] = depBase === "semver" ? `^${version}` : `${depBase}/${tarballName(name, version)}`
}
published.dependencies = dependencies

// The repo keeps `private: true` to prevent an accidental `pnpm publish`; the tarball must be installable.
delete published.private

// Write the temp package.json (atomic via tmp + rename) and run pack.
const bakPkg = join(pkgDir, "package.json.bak")
const tmpPkg = join(pkgDir, "package.json.pack-tmp")
writeFileSync(tmpPkg, `${JSON.stringify(published, null, "\t")}\n`)

// pnpm pack reads the package.json on disk in the workspace's package
// directory, but it also caches metadata from the install. A temp file
// alone isn't honored. The reliable pattern is to swap package.json with
// the rewritten version for the duration of the pack call.
renameSync(pkgJsonPath, bakPkg)
renameSync(tmpPkg, pkgJsonPath)

// Make sure dist has the sourcemap (build artifact requirement).
// pnpm pack picks up the `files` field from the active package.json, which
// already includes `dist`. The symlinks/sourcemaps travel with dist.
mkdirSync(outDir, { recursive: true })

try {
	execFileSync("pnpm", ["pack", "--pack-destination", outDir], { cwd: pkgDir, stdio: "inherit" })
} finally {
	// Always restore the source package.json, even on pack failure.
	// The swap is atomic so the workspace's normal install state is preserved.
	renameSync(pkgJsonPath, tmpPkg)
	renameSync(bakPkg, pkgJsonPath)
	rmSync(tmpPkg, { force: true })
}

console.log(`packed ${pkgName} -> ${outDir}`)
