#!/usr/bin/env node

// scripts/pack.mjs
//
// Build a clean, installable tarball for a baka workspace package.
//
// The repo's package.json files list `workspace:*` deps for `@repo/*` and
// `@baka/*` packages that are bundled into the dist by tsup. Those deps
// resolve fine in the workspace, but `pnpm install -g <tarball>` from a
// clean room would 404 on the npm registry. This script rewrites the
// published package.json to drop the bundled workspace deps and run-away
// devDeps so the resulting tarball is self-contained.

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "..")

const args = process.argv.slice(2)
if (args.length < 1) {
	console.error("usage: scripts/pack.mjs <baka|@baka/mcp-server> [--out <dir>]")
	process.exit(2)
}

const pkgName = args[0]
const outIdx = args.indexOf("--out")
const outDir = outIdx >= 0 ? resolve(args[outIdx + 1]) : join(REPO_ROOT, "dist-tarballs")

const pkgMap = {
	baka: "apps/cli",
	"@baka/mcp-server": "apps/mcp",
}
const pkgDir = join(REPO_ROOT, pkgMap[pkgName])
if (!pkgDir || !existsSync(pkgDir)) {
	console.error(`unknown package: ${pkgName} (expected baka or @baka/mcp-server)`)
	process.exit(2)
}

// Dist must exist; bail loudly if not.
const distPath = join(pkgDir, "dist", "index.js")
if (!existsSync(distPath)) {
	console.error(`missing build artifact: ${distPath}. run 'pnpm --filter ${pkgName} build' first.`)
	process.exit(2)
}

// Read the source package.json and the "published" form.
// The published form drops bundled workspace deps and devDeps; keeps only
// the external packages that the dist actually imports at runtime.
const pkgJsonPath = join(pkgDir, "package.json")
const src = JSON.parse(readFileSync(pkgJsonPath, "utf-8"))

// Build the published manifest.
const published = {
	...src,
}
delete published.devDependencies
delete published.optionalDependencies
delete published.peerDependencies
// Strip bundled workspace deps from the published deps.
// tsup inlines @repo/*, @baka/*, and the unscoped baka-sdk. Anything else
// stays as a runtime dep.
const filteredDeps = {}
if (published.dependencies) {
	for (const [name, ver] of Object.entries(published.dependencies)) {
		if (name.startsWith("@repo/") || name.startsWith("@baka/") || name === "baka-sdk") {
			continue
		}
		filteredDeps[name] = ver
	}
}
published.dependencies = filteredDeps

// Make the package public for the tarball. The repo keeps `private: true`
// to prevent accidental `pnpm publish`, but the tarball must installable
// globally, which requires public.
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
