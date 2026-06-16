import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { BAKA_PROJECT_PATHS, BAKA_USER_DIR } from "@repo/protocol"

// ---------------------------------------------------------------------------
// Source string parsing
//
// A "Baka source" is a string that identifies a module package to install.
// The pi-mono shape, which we adopt:
//   npm:@scope/pkg[@version]
//   git:host/path[@ref]
//   https://... or ssh://...     (protocol URL)
//   /abs/path                     (local absolute)
//   ./rel/path                    (local relative, resolved against settings file)
// ---------------------------------------------------------------------------

export type PackageSourceType = "npm" | "git" | "local"

export interface ParsedSource {
	raw: string
	type: PackageSourceType
	// For npm: the package spec (e.g. "@scope/pkg" or "@scope/pkg@1.2.3")
	// For git: the URL (without the leading "git:")
	// For local: the absolute path
	spec: string
	// The name of the module to materialize under. Derived from the source
	// (last path segment, normalized) for npm and git; the folder name for local.
	moduleName: string
	// Whether the source is pinned (has a version, ref, or commit). Pinned
	// sources are skipped by `baka update`.
	pinned: boolean
}

export function parseSource(raw: string): ParsedSource {
	const trimmed = raw.trim()
	if (trimmed === "") throw new Error("empty source")

	if (trimmed.startsWith("npm:")) {
		const spec = trimmed.slice(4)
		const pinned = /@[\dvx^~]/.test(spec) || (/@latest/.test(spec) === false && /@/.test(spec))
		// Extract package name (everything before the last @ that's followed by a version char)
		const m = spec.match(/^(@?[^@]+(?:[^@]))(?:@([^@]+))?$/)
		// Simpler: name is the part after the first @, up to the first @ that's followed by a version
		const name = spec
			.split("@")
			.slice(0, spec.startsWith("@") ? 2 : 1)
			.join("@")
		return {
			raw: trimmed,
			type: "npm",
			spec,
			moduleName: npmNameToDirName(name),
			pinned: !!m && m[2] !== undefined,
		}
	}

	if (trimmed.startsWith("git:") || /^https?:\/\//.test(trimmed) || /^ssh:\/\//.test(trimmed)) {
		const url = trimmed.startsWith("git:") ? trimmed.slice(4) : trimmed
		const refMatch = url.match(/[@#]([a-zA-Z0-9._/-]+)$/)
		const pinned = !!refMatch
		const cleanUrl = refMatch ? url.slice(0, -refMatch[0].length) : url
		return {
			raw: trimmed,
			type: "git",
			spec: cleanUrl,
			moduleName: gitNameToDirName(cleanUrl),
			pinned,
		}
	}

	if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("~")) {
		const abs = resolvePath(trimmed)
		const moduleName = abs.split("/").filter(Boolean).pop() ?? "module"
		return {
			raw: trimmed,
			type: "local",
			spec: abs,
			moduleName,
			pinned: false,
		}
	}

	throw new Error(
		`unrecognized source: "${trimmed}". Use npm:@scope/pkg[@ver], git:host/repo[@ref], /abs/path, ./rel/path, or https://...`,
	)
}

function resolvePath(p: string): string {
	if (p.startsWith("~")) return join(homedir(), p.slice(1))
	return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

function npmNameToDirName(name: string): string {
	// "@baka-mod/baka-base" -> "baka-mod-baka-base" (folder-safe, prefix-preserved)
	return name.replace(/^@/, "").replace("/", "-")
}

function gitNameToDirName(url: string): string {
	// "github.com/user/repo" or "https://github.com/user/repo" -> "repo"
	// Strip protocol and trailing slashes
	const stripped = url
		.replace(/^https?:\/\//, "")
		.replace(/^ssh:\/\//, "")
		.replace(/\.git$/, "")
		.replace(/\/$/, "")
	const parts = stripped.split("/")
	return parts[parts.length - 1] || "module"
}

// ---------------------------------------------------------------------------
// Settings storage
//
// Project scope: <cwd>/.baka/settings.json
// User scope:    ~/.config/baka/settings.json
// Project wins on dedup. Each scope keeps a list of source strings.
// ---------------------------------------------------------------------------

export interface BakaSettings {
	packages: string[]
}

export function projectSettingsPath(cwd: string): string {
	return join(cwd, BAKA_PROJECT_PATHS.ROOT, "settings.json")
}

export function userSettingsPath(): string {
	return join(homedir(), ".config", BAKA_USER_DIR, "settings.json")
}

export function readProjectSettings(cwd: string): BakaSettings {
	return readSettingsFrom(projectSettingsPath(cwd))
}

export function readUserSettings(): BakaSettings {
	return readSettingsFrom(userSettingsPath())
}

function readSettingsFrom(path: string): BakaSettings {
	if (!existsSync(path)) return { packages: [] }
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as BakaSettings
		if (!Array.isArray(raw.packages)) return { packages: [] }
		return raw
	} catch {
		return { packages: [] }
	}
}

function writeSettingsTo(path: string, settings: BakaSettings): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify(settings, null, "\t") + "\n", "utf-8")
}

// ---------------------------------------------------------------------------
// Materialized module directory
// ---------------------------------------------------------------------------

export function projectModulesDir(cwd: string): string {
	return join(cwd, BAKA_PROJECT_PATHS.ROOT, "modules")
}

export function userModulesDir(): string {
	return join(homedir(), ".local", "share", BAKA_USER_DIR, "modules")
}

// ---------------------------------------------------------------------------
// Install / remove / list / update
// ---------------------------------------------------------------------------

export interface InstallOptions {
	scope: "project" | "user"
	cwd: string
	// The path to the settings file where the source will be recorded.
	settingsPath: string
	// The directory where the module is materialized.
	modulesDir: string
}

export async function installSource(
	source: string,
	opts: InstallOptions,
): Promise<{ moduleName: string; modulePath: string }> {
	const parsed = parseSource(source)

	// 1. Add to settings (project or user).
	const settings = readSettingsFrom(opts.settingsPath)
	if (settings.packages.includes(parsed.raw)) {
		// Idempotent: source already listed. Ensure the module is materialized.
	} else {
		settings.packages.push(parsed.raw)
		writeSettingsTo(opts.settingsPath, settings)
	}

	// 2. Materialize the module on disk.
	const modulePath = join(opts.modulesDir, parsed.moduleName)
	mkdirSync(opts.modulesDir, { recursive: true })
	// Remove any stale copy to keep the install fresh.
	if (existsSync(modulePath)) {
		rmSync(modulePath, { recursive: true, force: true })
	}

	switch (parsed.type) {
		case "local":
			copyOrLink(parsed.spec, modulePath)
			break
		case "npm":
			await installFromNpm(parsed.spec, modulePath)
			break
		case "git":
			await installFromGit(parsed.spec, parsed.raw.includes("@") ? parsed.raw.split("@").pop() : undefined, modulePath)
			break
	}

	return { moduleName: parsed.moduleName, modulePath }
}

export function removeSource(source: string, opts: { settingsPath: string; modulesDir: string }): { removed: boolean } {
	const settings = readSettingsFrom(opts.settingsPath)
	const idx = settings.packages.indexOf(source)
	if (idx === -1) return { removed: false }
	settings.packages.splice(idx, 1)
	writeSettingsTo(opts.settingsPath, settings)

	// Best-effort: remove the materialized module if it exists. We don't
	// fail the remove if the materialization is missing.
	const parsed = parseSource(source)
	const modulePath = join(opts.modulesDir, parsed.moduleName)
	if (existsSync(modulePath)) {
		try {
			rmSync(modulePath, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	}
	return { removed: true }
}

export function listInstalledPackages(cwd: string): Array<{
	source: string
	scope: "project" | "user"
	moduleName: string
	modulePath: string
}> {
	const out: Array<{ source: string; scope: "project" | "user"; moduleName: string; modulePath: string }> = []
	const project = readProjectSettings(cwd)
	for (const raw of project.packages) {
		try {
			const parsed = parseSource(raw)
			out.push({
				source: raw,
				scope: "project",
				moduleName: parsed.moduleName,
				modulePath: join(projectModulesDir(cwd), parsed.moduleName),
			})
		} catch {
			/* skip malformed */
		}
	}
	const user = readUserSettings()
	for (const raw of user.packages) {
		try {
			const parsed = parseSource(raw)
			// Project wins on dedup.
			if (out.some((o) => o.moduleName === parsed.moduleName)) continue
			out.push({
				source: raw,
				scope: "user",
				moduleName: parsed.moduleName,
				modulePath: join(userModulesDir(), parsed.moduleName),
			})
		} catch {
			/* skip malformed */
		}
	}
	return out
}

export async function updateAll(cwd: string): Promise<Array<{ source: string; updated: boolean; reason?: string }>> {
	const project = readProjectSettings(cwd)
	const user = readUserSettings()
	const results: Array<{ source: string; updated: boolean; reason?: string }> = []
	for (const raw of project.packages) {
		results.push(
			await updateOne(raw, {
				scope: "project",
				cwd,
				settingsPath: projectSettingsPath(cwd),
				modulesDir: projectModulesDir(cwd),
			}),
		)
	}
	for (const raw of user.packages) {
		// Project takes priority: if the same module name is in both, skip the user entry.
		const projectNames = new Set(project.packages.map((s) => safeParseName(s)))
		if (projectNames.has(safeParseName(raw))) continue
		results.push(
			await updateOne(raw, { scope: "user", cwd, settingsPath: userSettingsPath(), modulesDir: userModulesDir() }),
		)
	}
	return results
}

async function updateOne(
	source: string,
	opts: InstallOptions,
): Promise<{ source: string; updated: boolean; reason?: string }> {
	const parsed = parseSource(source)
	if (parsed.pinned) {
		// Pinned sources are reconciled (moved to the existing ref) but never
		// moved to a newer ref. We no-op for now; full reconciliation can run
		// `git fetch && git reset --hard <ref>`.
		return { source, updated: false, reason: "pinned" }
	}
	// Unpinned: re-install to pull latest.
	await installSource(source, opts)
	return { source, updated: true }
}

function safeParseName(s: string): string {
	try {
		return parseSource(s).moduleName
	} catch {
		return ""
	}
}

// ---------------------------------------------------------------------------
// Source-specific materializers
// ---------------------------------------------------------------------------

function copyOrLink(src: string, dest: string): void {
	try {
		symlinkSync(src, dest, "dir")
	} catch {
		cpSync(src, dest, { recursive: true })
	}
}

async function installFromNpm(spec: string, dest: string): Promise<void> {
	// We shell out to `npm pack` and extract the tarball. The pack command
	// downloads the tarball, prints its filename, then we extract. We avoid
	// the `npm` global install path on purpose — modules are project-local
	// and unzipped, not installed in node_modules.
	const { spawn } = await import("node:child_process")
	const cwd = process.cwd()
	const { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } = await import("node:fs")
	const packOut = await new Promise<string>((resolveProm, reject) => {
		const child = spawn("npm", ["pack", spec, "--silent"], { cwd, stdio: ["ignore", "pipe", "pipe"] })
		let out = ""
		let err = ""
		child.stdout.on("data", (d) => {
			out += d.toString()
		})
		child.stderr.on("data", (d) => {
			err += d.toString()
		})
		child.on("exit", (code) => {
			if (code === 0) {
				resolveProm(out.trim().split("\n").pop() ?? "")
			} else {
				reject(new Error(`npm pack failed (exit ${code}): ${err}`))
			}
		})
		child.on("error", reject)
	})
	if (!packOut) throw new Error(`npm pack produced no output for ${spec}`)
	const tarball = join(cwd, packOut)
	mkdirSync(dest, { recursive: true })
	const untar = spawn("tar", ["-xzf", tarball, "-C", dest, "--strip-components=1"], { stdio: "inherit" })
	await new Promise<void>((resolveProm, reject) => {
		untar.on("exit", (c) => (c === 0 ? resolveProm() : reject(new Error(`tar extract failed (exit ${c})`))))
		untar.on("error", reject)
	})
	// Cleanup the tarball in the cwd.
	try {
		rmSync(tarball)
	} catch {
		/* best effort */
	}
	void writeFileSync
	void readdirSync
	void readFileSync
	void existsSync
}

async function installFromGit(url: string, ref: string | undefined, dest: string): Promise<void> {
	const { spawn } = await import("node:child_process")
	const args = ["clone"]
	if (ref) {
		args.push("--branch", ref, "--single-branch")
	}
	args.push(url, dest)
	const child = spawn("git", args, { stdio: "inherit" })
	await new Promise<void>((resolveProm, reject) => {
		child.on("exit", (c) => (c === 0 ? resolveProm() : reject(new Error(`git clone failed (exit ${c})`))))
		child.on("error", reject)
	})
}
