// scripts/third-party-notices.mjs
//
// The third-party code a package's bundle contains, found from its sourcemaps, and the text of
// THIRD-PARTY-NOTICES.md that credits it with each project's own license. `scripts/pack.mjs` writes that file into
// the tarball; a package that bundles nothing from npm gets no file.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|$|-)/i

function* mapFiles(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) yield* mapFiles(path)
		else if (entry.name.endsWith(".map")) yield path
	}
}

/** The package.json directory that owns a file inside node_modules, or undefined for our own sources. */
function ownerDir(file) {
	if (!file.includes(`${sep}node_modules${sep}`)) return undefined
	let dir = dirname(file)
	while (dir.includes(`${sep}node_modules${sep}`)) {
		const manifest = join(dir, "package.json")
		if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf-8")).name) return dir
		dir = dirname(dir)
	}
	return undefined
}

/** `[{ name, version, license, texts: [{ file, text }] }]`, sorted by name, for the npm code bundled into `distDir`. */
export function bundledPackages(distDir) {
	const owners = new Set()
	for (const mapPath of mapFiles(distDir)) {
		const map = JSON.parse(readFileSync(mapPath, "utf-8"))
		for (const source of map.sources ?? []) {
			const owner = ownerDir(resolve(dirname(mapPath), source))
			if (owner) owners.add(owner)
		}
	}
	const found = new Map()
	for (const dir of owners) {
		const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"))
		if (manifest.name.startsWith("@baka/")) continue
		const key = `${manifest.name}@${manifest.version}`
		const texts = readdirSync(dir)
			.filter((name) => LICENSE_FILE.test(name) && statSync(join(dir, name)).isFile())
			.sort()
			.map((file) => ({ file, text: readFileSync(join(dir, file), "utf-8").trim() }))
		const license =
			typeof manifest.license === "string" ? manifest.license : (manifest.license?.type ?? "see the text below")
		found.set(key, { name: manifest.name, version: manifest.version, license, texts })
	}
	return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

/** The THIRD-PARTY-NOTICES.md text, or undefined when the bundle contains no third-party code. */
export function noticesText(packageName, packages) {
	if (packages.length === 0) return undefined
	const lines = [
		`# Third-party notices for ${packageName}`,
		"",
		`${packageName} is licensed under the Apache License 2.0 (see LICENSE). Its bundle contains the following third-party code, each under its own license, reproduced below.`,
		"",
	]
	for (const pkg of packages) {
		lines.push(`## ${pkg.name} ${pkg.version}`, "", `License: ${pkg.license}`, "")
		for (const { file, text } of pkg.texts) lines.push(`### ${file}`, "", "```text", text, "```", "")
		if (pkg.texts.length === 0) lines.push("The project ships no separate license file; see its package.json.", "")
	}
	return `${lines.join("\n")}\n`
}
