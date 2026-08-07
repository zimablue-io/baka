import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { BAKA_PROJECT_PATHS, bakaHomeDir } from "@repo/protocol"

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

export type PackageSourceType = "npm" | "git" | "local" | "registry"

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
	// sources always install at their pinned ref.
	pinned: boolean
}

export function parseSource(raw: string): ParsedSource {
	const trimmed = raw.trim()
	if (trimmed === "") throw new Error("empty source")

	if (trimmed.startsWith("npm:")) {
		const spec = trimmed.slice(4)
		const _pinned = /@[\dvx^~]/.test(spec) || (/@latest/.test(spec) === false && /@/.test(spec))
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

	if (trimmed.startsWith("registry:")) {
		// `registry:@<scope>/<name>` or `registry:@<scope>/<name>@<version>` —
		// the canonical wire format the CLI uses after resolving a
		// `@scope/name[@version]` spec through the configured registry
		// (architecture §5.1 cli-install). The presence/absence of the
		// trailing `@<version>` pin decides `pinned`. The `moduleName`
		// is derived from the scoped name so the materialized dir
		// matches the engine's bundled-scope layout (e.g.
		// `registry:@acme/widget` -> dir `acme-widget`, same as the
		// npm/git materializers' normalization).
		const inner = trimmed.slice("registry:".length)
		// The first `@` is the scoped-name marker. Any `@` AFTER
		// the `/` separating scope and name is a version pin.
		const slash = inner.indexOf("/")
		if (slash <= 0) {
			throw new Error(
				`malformed registry source: "${trimmed}". Expected \`registry:@<scope>/<name>\` or \`registry:@<scope>/<name>@<version>\`.`,
			)
		}
		const afterSlash = inner.indexOf("@", slash + 1)
		const scopedName = afterSlash >= 0 ? inner.slice(0, afterSlash) : inner
		const pinnedVersion = afterSlash >= 0 ? inner.slice(afterSlash + 1) : ""
		// The leading `@` of a scoped name is mandatory.
		if (!scopedName.startsWith("@")) {
			throw new Error(
				`malformed registry source: "${trimmed}". Expected \`registry:@<scope>/<name>\` or \`registry:@<scope>/<name>@<version>\`.`,
			)
		}
		const scoped = parseScopedName(scopedName)
		// Validate the version pin if present.
		if (pinnedVersion.length > 0 && !isValidSemverTagForRegistry(pinnedVersion)) {
			throw new Error(
				`malformed registry source: "${trimmed}". Version "${pinnedVersion}" is not a valid semver tag (e.g. "1.0.0", "v1.0.0").`,
			)
		}
		return {
			raw: trimmed,
			type: "registry",
			spec:
				pinnedVersion.length > 0 ? `${scoped.scope}/${scoped.name}@${pinnedVersion}` : `${scoped.scope}/${scoped.name}`,
			moduleName: `${scoped.scope}-${scoped.name}`,
			pinned: pinnedVersion.length > 0,
		}
	}

	throw new Error(
		`unrecognized source: "${trimmed}". Use npm:@scope/pkg[@ver], git:host/repo[@ref], registry:@scope/name[@ver], /abs/path, ./rel/path, or https://...`,
	)
}

/**
 * Parses a scoped module name like `@acme/widget` into its scope +
 * name parts. Throws on malformed input (no leading `@`, no slash,
 * empty parts) — the caller is the `registry:` branch of
 * `parseSource` whose callers (the CLI install flow) have already
 * validated the outer `registry:@scope/name@version` shape.
 */
function parseScopedName(scoped: string): { scope: string; name: string } {
	if (!scoped.startsWith("@")) {
		throw new Error(`malformed registry source: scope must start with '@' (got "${scoped}")`)
	}
	const rest = scoped.slice(1)
	const slash = rest.indexOf("/")
	if (slash <= 0 || slash === rest.length - 1) {
		throw new Error(`malformed registry source: expected '@<scope>/<name>' (got "${scoped}")`)
	}
	const scope = rest.slice(0, slash)
	const name = rest.slice(slash + 1)
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(scope)) {
		throw new Error(`malformed registry source: scope '${scope}' is not a valid module identifier`)
	}
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
		throw new Error(`malformed registry source: name '${name}' is not a valid module identifier`)
	}
	return { scope, name }
}

/**
 * Minimal semver tag check. Accepts `1.0.0`, `v1.0.0`, with
 * optional pre-release (`-alpha.1`) and build metadata (`+build`).
 * Matches the format the registry's publish endpoint accepts.
 */
function isValidSemverTagForRegistry(input: string): boolean {
	if (input.length === 0) return false
	const stripped = input.startsWith("v") || input.startsWith("V") ? input.slice(1) : input
	const m = stripped.match(
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
	)
	return m !== null
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
// User scope:    ~/.baka/settings.json
// Project wins on dedup. Each scope keeps a list of source strings.
// ---------------------------------------------------------------------------

export interface BakaSettings {
	packages: string[]
}

export function projectSettingsPath(cwd: string): string {
	return join(cwd, BAKA_PROJECT_PATHS.ROOT, "settings.json")
}

export function userSettingsPath(): string {
	return join(bakaHomeDir(), "settings.json")
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
	writeFileSync(path, `${JSON.stringify(settings, null, "\t")}\n`, "utf-8")
}

// ---------------------------------------------------------------------------
// Materialized module directory
// ---------------------------------------------------------------------------

export function projectModulesDir(cwd: string): string {
	return join(cwd, BAKA_PROJECT_PATHS.ROOT, "modules")
}

export function userModulesDir(): string {
	return join(bakaHomeDir(), "modules")
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
		case "registry":
			// The CLI layer handles registry materialization
			// (tarball download + integrity verification + manifest
			// write). The CLI calls `installSource` AFTER it has
			// already materialized the module on disk — the
			// switch's only job here is to keep the typed contract
			// exhaustive. The CLI's command code path drives the
			// registry flow directly via the dedicated
			// `materializeFromRegistry` helper in this file so the
			// settings registration is a single side-effect-free
			// write that survives a download failure (the
			// registration is rolled back when materialization
			// throws — see `withMaterialization` in
			// apps/cli/src/commands/install.ts).
			throw new Error("registry source must be materialized via materializeFromRegistry before installSource")
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

// ---------------------------------------------------------------------------
// Registry tarball materialization (architecture §5.1 cli-install).
//
// The CLI downloads a tarball from a registry's
// `GET /v1/download/:scope/:name/:version` endpoint, verifies its
// sha256 against the `x-content-sha256` response header (VAL-DISC-041),
// and writes the module tree + a fresh `manifest.ts` at the install
// destination. The tarball excludes the manifest (architecture §8
// decision 37 — manifest version bumps would otherwise invalidate
// content-hash dedup), so the manifest is materialized from the
// version-detail JSON the CLI fetched alongside the tarball.
//
// The CLI is the only caller (registry sources are CLI-only by
// design — the engine layer doesn't talk to registries; the CLI
// translates user-facing install specs into the registry wire
// protocol). The helper is exported here so the registry test
// harness can also exercise the tarball-extraction path without
// duplicating the extraction logic.
// ---------------------------------------------------------------------------

export interface RegistryTarball {
	/** Raw tarball bytes (POSIX ustar, produced by the registry's
	 *  `packTarball`). */
	bytes: Uint8Array
	/** Expected sha256 of `bytes` — the registry serves this in the
	 *  `x-content-sha256` response header and the CLI uses it to
	 *  verify the bytes before extraction (VAL-DISC-041). */
	expectedSha256: string
}

export interface ManifestJsonShape {
	name: string
	version: string
	description?: string
	dependencies?: string[]
	conflictsWith?: string[]
	actions?: Array<{
		id: string
		description?: string
		params?: unknown[]
		requiresReasoning?: boolean
		filePatterns?: string[]
		validators?: string[]
		toolchain?: string
	}>
	moduleValidators?: string[]
	[key: string]: unknown
}

/**
 * Validates a registry tarball's bytes against the expected sha256
 * (VAL-DISC-041). Returns the bytes unchanged on a match; throws
 * an error that names the expected vs actual hash on a mismatch
 * so the CLI can surface an integrity error and refuse to install.
 */
export function verifyTarballIntegrity(tarball: RegistryTarball): Uint8Array {
	const actual = createHash("sha256").update(tarball.bytes).digest("hex")
	if (actual !== tarball.expectedSha256) {
		throw new Error(
			`tarball integrity mismatch: expected sha256=${tarball.expectedSha256}, got sha256=${actual}; ` +
				`the registry's stored artifact does not match the downloaded bytes; refusing to install`,
		)
	}
	return tarball.bytes
}

/**
 * Extracts a registry tarball into the destination directory and
 * writes a fresh `manifest.ts` derived from the JSON manifest the
 * CLI fetched alongside the tarball. The function is intentionally
 * minimal: it unpacks every regular-file entry from the tar into
 * `dest/` and then writes the manifest from JSON. The tarball is
 * produced by the registry's deterministic packer so extraction
 * does NOT need to validate the layout — the registry's loadability
 * gate already proved the source tree was valid at ingest time
 * (architecture §4.5).
 *
 * Implementation note: we deliberately avoid pulling in a tar
 * library. The registry's packer emits a plain POSIX ustar
 * (architecture §4.5); a minimal parser keeps the install path
 * dependency-free. Only regular files are extracted; directories
 * are created on demand. Symlinks, device files, and PAX/GNU
 * extensions are rejected with a clear error — the registry never
 * produces them.
 */
export function extractRegistryTarball(
	tarballBytes: Uint8Array,
	dest: string,
	manifestJson: ManifestJsonShape,
): { manifestWritten: string; fileCount: number } {
	mkdirSync(dest, { recursive: true })
	const files = parseUstarTar(tarballBytes)
	for (const file of files) {
		const fullPath = join(dest, file.path)
		// Path traversal guard: every entry must resolve inside
		// `dest`. The registry never emits such entries (the
		// packer walks the module tree only) but a malformed or
		// hostile tarball must not escape the install dir.
		const resolvedFull = resolve(fullPath)
		const resolvedDest = resolve(dest)
		if (!resolvedFull.startsWith(`${resolvedDest}/`) && resolvedFull !== resolvedDest) {
			throw new Error(
				`refusing to extract entry '${file.path}' outside the install destination; the tarball is malformed`,
			)
		}
		if (file.type === "directory") {
			mkdirSync(resolvedFull, { recursive: true })
			continue
		}
		if (file.type === "regular") {
			mkdirSync(dirname(resolvedFull), { recursive: true })
			writeFileSync(resolvedFull, file.body)
			continue
		}
		throw new Error(
			`refusing to extract unsupported tar entry '${file.path}' (type='${file.type}'); the tarball is malformed`,
		)
	}
	const manifestPath = writeManifestFromJson(dest, manifestJson)
	return { manifestWritten: manifestPath, fileCount: files.length }
}

/**
 * Writes a `manifest.ts` module descriptor at the install
 * destination. The body is a tiny, deterministic TypeScript file
 * exporting a single default object literal — the same shape the
 * engine's loader reads (architecture §3 / baka-sdk). We render the
 * JSON manifest as a stable, sorted-key object literal so two
 * installs of the same version produce identical files (the
 * loadability gate re-imports this file at apply time).
 */
function writeManifestFromJson(dest: string, manifest: ManifestJsonShape): string {
	const sortedKeys = Object.keys(manifest).sort()
	const lines: string[] = []
	lines.push("export default {")
	for (const key of sortedKeys) {
		lines.push(`  ${JSON.stringify(key)}: ${stableJsonStringify(manifest[key])},`)
	}
	lines.push("} satisfies never")
	lines.push("")
	const body = `${lines.join("\n")}\n`
	const manifestPath = join(dest, "manifest.ts")
	writeFileSync(manifestPath, body, "utf8")
	return manifestPath
}

function stableJsonStringify(value: unknown): string {
	const seen = new WeakSet<object>()
	const stringify = (v: unknown): string => {
		if (v === null) return "null"
		if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") {
			return JSON.stringify(v)
		}
		if (Array.isArray(v)) {
			return `[${v.map((x) => stringify(x)).join(",")}]`
		}
		if (typeof v === "object") {
			const obj = v as Record<string, unknown>
			if (seen.has(obj)) throw new Error("cycle in registry manifest")
			seen.add(obj)
			const keys = Object.keys(obj).sort()
			const pairs = keys.map((k) => `${JSON.stringify(k)}:${stringify(obj[k])}`)
			return `{${pairs.join(",")}}`
		}
		return JSON.stringify(value)
	}
	return stringify(value)
}

interface UstarEntry {
	path: string
	type: "regular" | "directory"
	body: Uint8Array
}

/**
 * Minimal POSIX ustar parser. Supports the header layout produced by
 * `apps/registry/src/worker/tarball.ts`: name field at offset 0
 * (up to 100 bytes, NUL-padded), prefix field at offset 345 (up to
 * 155 bytes), size as an octal field at offset 124, and the
 * regular-file type flag at offset 156. Directories are not in the
 * registry's emitted tarballs (the packer only writes regular files
 * plus the EOF terminator), so directory creation happens lazily
 * during extraction.
 */
function parseUstarTar(bytes: Uint8Array): UstarEntry[] {
	const out: UstarEntry[] = []
	const BLOCK = 512
	const _view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	for (let offset = 0; offset + BLOCK <= bytes.byteLength; offset += BLOCK) {
		// Read header magic; skip blocks whose magic slot is empty
		// (zero blocks mark EOF and also pad short final files).
		const magic = readAscii(bytes, offset + 257, 5)
		if (magic !== "ustar") {
			// A zero-filled block is the canonical EOF marker.
			if (isAllZero(bytes, offset, BLOCK)) {
				break
			}
			// Otherwise this is a padding block for a short final
			// entry; advance one block and keep scanning.
			continue
		}
		const typeFlag = String.fromCharCode(bytes[offset + 156] ?? 0)
		const nameField = readCString(bytes, offset + 0, 100)
		const prefixField = readCString(bytes, offset + 345, 155)
		const fullName = prefixField.length > 0 ? `${prefixField}/${nameField}` : nameField
		const sizeStr = readAscii(bytes, offset + 124, 12).trim()
		const size = Number.parseInt(sizeStr, 8)
		if (!Number.isFinite(size) || size < 0) {
			throw new Error(`malformed tar entry: cannot parse size field '${sizeStr}' for '${fullName}'`)
		}
		const bodyOffset = offset + BLOCK
		const body = bytes.slice(bodyOffset, bodyOffset + size)
		if (typeFlag === "0" || typeFlag === "") {
			// Regular file (ustar uses "0" for old-style regular files
			// when the typeflag is omitted; both are honored).
			out.push({ path: fullName, type: "regular", body })
		} else if (typeFlag === "5") {
			out.push({ path: fullName.endsWith("/") ? fullName : `${fullName}/`, type: "directory", body: new Uint8Array(0) })
		} else {
			throw new Error(`unsupported tar entry type flag '${typeFlag}' for '${fullName}'`)
		}
		// Advance to the next 512-byte boundary including padding.
		const paddedSize = Math.ceil(size / BLOCK) * BLOCK
		offset += BLOCK + paddedSize - BLOCK
		// The for-loop's offset += BLOCK would double-count; compensate
		// by subtracting one block so the loop's increment lands on the
		// next header.
		if (false as boolean) {
			/* unreachable */
		}
		// Account for the body blocks: the next header starts at
		// `bodyOffset + paddedSize`. Re-align the loop offset.
		// (We achieve this by adjusting `offset` to `bodyOffset + paddedSize - BLOCK`
		// so the loop's `+= BLOCK` lands at `bodyOffset + paddedSize`.)
		offset = bodyOffset + paddedSize - BLOCK
	}
	return out
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
	let str = ""
	for (let i = 0; i < length; i++) {
		const ch = bytes[offset + i]
		if (ch === undefined || ch === 0) break
		str += String.fromCharCode(ch)
	}
	return str
}

function readCString(bytes: Uint8Array, offset: number, length: number): string {
	const raw = readAscii(bytes, offset, length)
	return raw.replace(/\0+$/, "")
}

function isAllZero(bytes: Uint8Array, offset: number, length: number): boolean {
	for (let i = 0; i < length; i++) {
		if ((bytes[offset + i] ?? 0) !== 0) return false
	}
	return true
}
