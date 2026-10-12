#!/usr/bin/env node
// Stage the install site: everything a user needs to install Baka, served as static files next to the dashboard.
//
//   node scripts/stage-site.mjs <outDir> [--site-url <url>]
//
// Writes, under <outDir>:
//   install.sh                                   the installer (also at /install)
//   releases/v<version>/<tarball>.tgz            one tarball per published package
//   releases/v<version>/manifest.json            version, file names, sha256 and size of each
//   releases/latest/<package>.tgz + manifest.json  the same files under unversioned names (baka-cli.tgz, ...)
//
// The tarballs are packed here, with the dependencies between them pointing at <site-url>/releases/v<version>/, so
// `npm install <site-url>/releases/latest/baka-core.tgz` resolves @baka/protocol from the same place. The site URL
// comes from --site-url or BAKA_SITE_URL, and defaults to the public one. Needs `pnpm build` first.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const outDir = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : undefined
if (!outDir) {
	console.error("usage: scripts/stage-site.mjs <outDir> [--site-url <url>]")
	process.exit(2)
}
const siteFlag = args.indexOf("--site-url")
const siteUrl = (
	(siteFlag >= 0 ? args[siteFlag + 1] : undefined) ??
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: this script is not a turbo task
	process.env.BAKA_SITE_URL ??
	"https://baka.dashboard.zimablue.io"
).replace(/\/+$/, "")

const { version } = JSON.parse(readFileSync(join(repoRoot, "apps", "cli", "package.json"), "utf-8"))
const versioned = join(outDir, "releases", `v${version}`)
const latest = join(outDir, "releases", "latest")

const work = mkdtempSync(join(tmpdir(), "baka-site-"))
try {
	execFileSync(
		"node",
		[join(repoRoot, "scripts", "pack-all.mjs"), "--out", work, "--dep-base", `${siteUrl}/releases/v${version}`],
		{ stdio: ["ignore", "ignore", "inherit"] },
	)

	rmSync(join(outDir, "releases"), { recursive: true, force: true })
	mkdirSync(versioned, { recursive: true })
	mkdirSync(latest, { recursive: true })

	const files = []
	for (const name of readdirSync(work)
		.filter((f) => f.endsWith(".tgz"))
		.sort()) {
		const bytes = readFileSync(join(work, name))
		const unversioned = name.replace(`-${version}.tgz`, ".tgz")
		files.push({
			name,
			latest: unversioned,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			bytes: bytes.length,
		})
		copyFileSync(join(work, name), join(versioned, name))
		copyFileSync(join(work, name), join(latest, unversioned))
	}
	const manifest = `${JSON.stringify({ schema: "baka.release/1", version, files }, null, "\t")}\n`
	writeFileSync(join(versioned, "manifest.json"), manifest)
	writeFileSync(join(latest, "manifest.json"), manifest)
	copyFileSync(join(repoRoot, "install.sh"), join(outDir, "install.sh"))
	copyFileSync(join(repoRoot, "install.sh"), join(outDir, "install"))
	console.log(`staged baka ${version} (${files.length} packages) at ${outDir}, for ${siteUrl}`)
} finally {
	rmSync(work, { recursive: true, force: true })
}
