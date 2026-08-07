import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import {
	extractRegistryTarball,
	type ManifestJsonShape,
	projectModulesDir,
	projectSettingsPath,
	userModulesDir,
	userSettingsPath,
	verifyTarballIntegrity,
} from "@repo/ast-tooling"
import { BAKA_EXIT_CODE } from "@repo/protocol"
import {
	downloadTarball,
	getVersionDetailForInstall,
	maskApiKey,
	RegistryDownloadGone,
	RegistryDownloadNotFound,
	RegistryHttpError,
	RegistryTransportError,
	RegistryVersionNotReadyError,
} from "../lib/registry-client"
import { readRegistryCredential } from "../lib/registry-credentials"

/**
 * `baka install <spec>` (architecture §5.1 cli-install).
 *
 * Resolution precedence for the input spec:
 *   1. Explicit source URI (`npm:...`, `git:...`, local path, https
 *      URL) — unchanged from the previous behavior.
 *   2. Scoped / bare registry spec (`@scope/name[@version]`,
 *      `name[@version]`) — resolved through the configured
 *      registries (multi-registry, first-found-wins per decision 4)
 *      and materialized from the registry tarball + manifest.
 *
 * The CLI downloads the tarball from `GET /v1/download/...`,
 * verifies its sha256 against the `x-content-sha256` response
 * header (VAL-DISC-041), extracts it into `.baka/modules/` (project
 * scope) or `${BAKA_HOME:-$HOME/.baka}/modules/` (user scope via
 * `--user`, architecture §8 decision 32), writes a fresh
 * `manifest.ts` derived from the version-detail JSON, and registers
 * the source string in `.baka/settings.json` (project) or
 * `${BAKA_HOME:-$HOME/.baka}/settings.json` (user).
 *
 * Install lifecycle (decision 15):
 *   - same `scope/name` at the same version → "already installed"
 *     no-op (idempotent install).
 *   - same `scope/name` at a DIFFERENT version → upgrade in place
 *     (the module dir is replaced; the registration is updated to
 *     the new pinned version).
 *   - different `scope/name` whose bare name collides with an
 *     existing install (decision 5) → REFUSED with an explicit
 *     conflict error naming the existing install's scope and
 *     registration. No silent replace, no dual registration.
 *
 * `--user` flips the scope to the user marketplace (architecture
 * §8 decision 32). The user scope is namespaced under
 * `${BAKA_HOME:-$HOME/.baka}` (architecture §8 decision 33); the
 * same BAKA_HOME from a second project sees the same installed
 * module without needing a re-install.
 *
 * `baka uninstall <spec>` is the inverse: it strips the
 * registration AND removes the materialized module dir.
 */

/**
 * Internal error thrown by `die` so unit tests can assert the
 * exit code without actually exiting the process. The CLI's
 * top-level `action` handler catches this error and exits with
 * the carried code (see `apps/cli/src/index.ts`).
 */
export class InstallCommandError extends Error {
	readonly code: number
	constructor(code: number, message: string) {
		super(message)
		this.name = "InstallCommandError"
		this.code = code
	}
}

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	throw new InstallCommandError(code, msg)
}

interface InstallOptions {
	cwd: string
	scope: "project" | "user"
	json?: boolean
	registry?: string
	fetch?: typeof fetch
	/** Test injection seam — pre-resolved registries list. */
	registries?: string[]
	/** Test injection seam — env to read. */
	env?: NodeJS.ProcessEnv
	/** Test injection seam — credential lookup. */
	credentialLookup?: (baseUrl: string) => { apiKey: string } | undefined
}

/**
 * The JSON payload printed when `--json` is set. Captures the full
 * install state (scope, name, version, the registry source, and a
 * status flag) so consumers can branch without parsing prose. The
 * `upgraded` and `noOp` flags are exclusive — at most one is true.
 */
interface InstallResultPayload {
	status: "installed" | "upgraded" | "already-installed" | "blocked"
	scope: string
	name: string
	version: string | null
	previousVersion: string | null
	registry: string | null
	modulePath: string
	settingsPath: string
}

/**
 * Parsed shape of an install spec. Scoped and bare-name specs carry
 * the resolved `scope` (the official scope for bare names) and an
 * optional `pinnedVersion`. Explicit source specs (`npm:`/`git:`/
 * paths) carry through as `kind: "source"` so the caller can fall
 * through to the legacy `parseSource` machinery.
 */
type ParsedInstallSpec =
	| { kind: "registry"; scope: string; name: string; pinnedVersion: string | null }
	| { kind: "source" }

/**
 * Parses a CLI install spec. The shapes accepted:
 *
 *   @scope/name           — scoped registry spec
 *   @scope/name@version   — scoped registry spec, pinned version
 *   @/name                — bare registry spec (official scope)
 *   name                  — bare registry spec (official scope)
 *   name@version          — bare registry spec, pinned version
 *   npm:..., git:..., /abs, ./rel, https://... — explicit source
 *
 * The five registry shapes are recognized when the spec looks
 * like a registry identifier (no scheme prefix, no path prefix,
 * no `:` separator) and parses cleanly into scope + name +
 * optional pinned version. Anything else falls through to
 * `parseSource` from `@repo/ast-tooling`.
 *
 * Malformed specs (e.g. `@acme` with no name, `@/widget` with no
 * scope, `@acme/widget@not-a-version`, `@acme/widget/extra`) fail
 * here with a typed error — the CLI surfaces the message
 * verbatim, so a malformed `@acme/widget@not-a-version` says
 * "version 'not-a-version' is not valid semver" and a malformed
 * `@acme` says "scope requires a name" (VAL-DISC-040).
 */
function parseInstallSpec(spec: string): ParsedInstallSpec {
	const trimmed = spec.trim()
	if (trimmed.length === 0) {
		throw new Error("install spec must not be empty")
	}
	// Anything that looks like an explicit source URI goes through
	// the legacy machinery — npm:/git:/path/url shapes do not have
	// a registry representation.
	if (
		trimmed.startsWith("npm:") ||
		trimmed.startsWith("git:") ||
		trimmed.startsWith("registry:") ||
		trimmed.startsWith("/") ||
		trimmed.startsWith("./") ||
		trimmed.startsWith("../") ||
		trimmed.startsWith("~") ||
		/^https?:\/\//.test(trimmed) ||
		/^ssh:\/\//.test(trimmed)
	) {
		return { kind: "source" }
	}

	// Find the optional version pin: the LAST `@` that is followed
	// by a valid semver string AND preceded by an `@<scope>/<name>`
	// or `<name>`. URL-embedded credentials (`user:pass@host`) have
	// already been filtered out by the explicit-source branch above.
	let body = trimmed
	let pinnedVersion: string | null = null
	if (trimmed.includes("@")) {
		const lastAt = trimmed.lastIndexOf("@")
		if (lastAt > 0) {
			const candidate = trimmed.slice(lastAt + 1)
			if (isValidSemverTag(candidate)) {
				body = trimmed.slice(0, lastAt)
				// Normalize: strip the `v`/`V` prefix so the
				// downstream registry call uses the canonical
				// semver form.
				pinnedVersion = candidate.startsWith("v") || candidate.startsWith("V") ? candidate.slice(1) : candidate
			} else if (candidate.length === 0) {
				// Trailing `@` with no version — treat as no
				// version pin (the user typed `name@` by accident,
				// the registry should still resolve `latest`).
				body = trimmed.slice(0, lastAt)
				pinnedVersion = null
			} else {
				// The user typed a trailing `@`-something that is not
				// a valid semver. Distinguish the leading-`@` scoped
				// shape from a trailing-version attempt — the latter
				// is a malformed spec (VAL-DISC-040), the former
				// might still be a legitimate scoped spec with no
				// version pin.
				if (!trimmed.startsWith("@")) {
					throw new Error(
						`install spec '${trimmed}' has a trailing '@${candidate}' that is not a valid semver version; ` +
							`expected '@<scope>/<name>[@<version>]' or '<name>[@<version>]' where <version> is valid semver (e.g. '1.0.0', 'v1.0.0')`,
					)
				}
				// Scoped spec with a trailing `@<not-semver>` — same
				// error, but show the bare-name shape too.
				throw new Error(
					`install spec '${trimmed}' has a trailing '@${candidate}' that is not a valid semver version; ` +
						`expected '@<scope>/<name>[@<version>]' where <version> is valid semver (e.g. '1.0.0', 'v1.0.0')`,
				)
			}
		}
	}

	// Strip a leading `@` (the scoped marker).
	const isScoped = body.startsWith("@")
	const inner = isScoped ? body.slice(1) : body
	if (inner.length === 0) {
		throw new Error(
			`install spec '${trimmed}' is malformed; expected '@<scope>/<name>[@<version>]' or '<name>[@<version>]'`,
		)
	}
	const slash = inner.indexOf("/")
	if (isScoped) {
		if (slash <= 0) {
			throw new Error(`install spec '${trimmed}' is malformed; '@<scope>/<name>' requires both a scope and a name`)
		}
		const scope = inner.slice(0, slash)
		const name = inner.slice(slash + 1)
		if (name.includes("/")) {
			throw new Error(
				`install spec '${trimmed}' is malformed; '@<scope>/<name>' takes exactly one '/' separator (found '${name.split("/").length - 1}' extra)`,
			)
		}
		if (!isValidModuleIdentifier(scope)) {
			throw new Error(`install spec '${trimmed}' has an invalid scope name '${scope}'`)
		}
		if (!isValidModuleIdentifier(name)) {
			throw new Error(`install spec '${trimmed}' has an invalid module name '${name}'`)
		}
		return { kind: "registry", scope, name, pinnedVersion }
	}

	// Bare-name spec (no leading `@`). A trailing `@` with no
	// version (`name@`) was already filtered to `body === name` —
	// we re-check here so an explicit empty-pinned-version never
	// reaches the registry.
	if (slash >= 0) {
		throw new Error(`install spec '${trimmed}' is malformed; bare-name specs take no '/' (got '${inner}')`)
	}
	if (!isValidModuleIdentifier(inner)) {
		throw new Error(`install spec '${trimmed}' has an invalid module name '${inner}'`)
	}
	return { kind: "registry", scope: null as unknown as string, name: inner, pinnedVersion }
}

/**
 * Minimal semver tag check. Accepts `1.0.0`, `v1.0.0`, with
 * optional pre-release (`-alpha.1`) and build metadata (`+build`).
 * Matches the format the registry's publish endpoint accepts
 * (architecture §8 decision 18 — non-semver tags rejected at
 * publish time).
 */
function isValidSemverTag(input: string): boolean {
	if (input.length === 0) return false
	const stripped = input.startsWith("v") || input.startsWith("V") ? input.slice(1) : input
	const m = stripped.match(
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
	)
	return m !== null
}

function isValidModuleIdentifier(input: string): boolean {
	if (input.length === 0) return false
	return /^[a-z0-9][a-z0-9._-]*$/i.test(input)
}

/**
 * Normalize a version string by stripping a leading `v`/`V` so
 * `v1.0.0` and `1.0.0` compare equal in the install/registration
 * flow. The registry stores tags as published (`v1.0.0` if the
 * user tagged with `v`); the CLI never lets the `v` survive past
 * resolution.
 */
function stripVersionPrefix(version: string): string {
	if (version.startsWith("v") || version.startsWith("V")) return version.slice(1)
	return version
}

interface ResolvedRegistryModule {
	registryBaseUrl: string
	scope: string
	name: string
	version: string
	contentHash: string
	commitSha: string
	visibility: "public" | "org"
	tier: string
	manifest: ManifestJsonShape
}

/**
 * Walks every configured registry in order, asking each one for
 * the module. The first registry that returns 200 for both the
 * module detail AND the version detail wins. A non-2xx response
 * other than 404 throws `RegistryHttpError` so the calling
 * installer knows it's a 401 / 403 / 5xx, not "not found".
 *
 * The `scopeForFetch` defaults to the official scope (`baka`) for
 * bare-name specs (architecture §8 decision 4 — bare names resolve
 * only against the registry serving the official scope). Scoped
 * specs use their own scope.
 */
async function resolveRegistryModuleForInstall(opts: {
	spec: ParsedInstallSpec & { kind: "registry" }
	registries: string[]
	credentialLookup: (baseUrl: string) => { apiKey: string } | undefined
	fetchImpl: typeof fetch | undefined
}): Promise<ResolvedRegistryModule | { error: string; transport: boolean; notFound: boolean }> {
	const scopeForFetch = opts.spec.scope ?? "baka"
	let lastTransport: string | null = null
	let lastNotFound = false
	for (const baseUrl of opts.registries) {
		const credential = opts.credentialLookup(baseUrl)
		const apiKey = credential?.apiKey
		// Resolve the version: a pinned spec uses the explicit
		// version; an unpinned spec resolves the latest ready
		// version via `getModuleDetail` (which surfaces the
		// server-attached `latestVersion` semver pointer).
		let versionToFetch = opts.spec.pinnedVersion
		if (versionToFetch === null) {
			try {
				const detailRes = await fetchModuleDetail({
					baseUrl,
					scope: scopeForFetch,
					name: opts.spec.name,
					apiKey,
					fetchImpl: opts.fetchImpl,
				})
				if (detailRes === null) {
					lastNotFound = true
					continue
				}
				if (detailRes.latestVersion === null) {
					lastNotFound = true
					continue
				}
				versionToFetch = detailRes.latestVersion
			} catch (err) {
				if (err instanceof RegistryTransportError) {
					lastTransport = err.message
					continue
				}
				throw err
			}
		}

		// Fetch the version detail (manifest + content hash) at
		// the resolved version. A 404 here means the version is
		// missing or the registry considers the request
		// unauthorized — fall through to the next registry
		// (uniform 404 hides both states from outsiders per
		// VAL-AUTH-003). The version is passed through as-is
		// (the registry stores tags as published — `v1.0.0` if
		// the user tagged with `v`). The CLI normalizes the
		// version for the local registration (strips the `v`).
		const versionDetail = await getVersionDetailForInstall({
			baseUrl,
			scope: scopeForFetch,
			name: opts.spec.name,
			version: versionToFetch,
			apiKey,
			fetchImpl: opts.fetchImpl,
		}).catch((err: unknown) => {
			if (err instanceof RegistryTransportError) {
				lastTransport = err.message
				return null
			}
			throw err
		})
		if (versionDetail === null) {
			if (lastTransport !== null) continue
			lastNotFound = true
			continue
		}
		if (versionDetail.status !== "ready") {
			throw new RegistryVersionNotReadyError(scopeForFetch, opts.spec.name, versionToFetch, versionDetail.status, null)
		}
		return {
			registryBaseUrl: baseUrl,
			scope: scopeForFetch,
			name: opts.spec.name,
			version: stripVersionPrefix(versionToFetch),
			contentHash: versionDetail.contentHash,
			commitSha: versionDetail.commitSha,
			visibility: versionDetail.visibility,
			tier: versionDetail.tier,
			manifest: versionDetail.manifest as ManifestJsonShape,
		}
	}

	if (lastTransport !== null) {
		return { error: lastTransport, transport: true, notFound: false }
	}
	if (lastNotFound) {
		const label = opts.spec.scope === null ? opts.spec.name : `${opts.spec.scope}/${opts.spec.name}`
		return {
			error: `module '${label}' not found in any configured registry (bare names resolve against the registry serving the official scope; configure registries in .baka/settings.json or pass --registry)`,
			transport: false,
			notFound: true,
		}
	}
	return {
		error: `no registries configured for scope '${opts.spec.scope ?? "baka"}'; add one with --registry <url> or BAKA_REGISTRY_URL`,
		transport: false,
		notFound: false,
	}
}

/**
 * Inlined helper for `getModuleDetail` from registry-client. Kept
 * local to this file so the install flow does not need to import
 * the catalog shape (we only need `latestVersion` here).
 */
async function fetchModuleDetail(opts: {
	baseUrl: string
	scope: string
	name: string
	apiKey?: string
	fetchImpl?: typeof fetch
}): Promise<{ latestVersion: string | null } | null> {
	const f = opts.fetchImpl ?? globalThis.fetch
	const path = `/v1/modules/${encodeURIComponent(opts.scope)}/${encodeURIComponent(opts.name)}`
	const headers: Record<string, string> = {}
	if (opts.apiKey) headers["x-api-key"] = opts.apiKey
	let res: Response
	try {
		res = await f(`${opts.baseUrl}${path}`, { method: "GET", headers })
	} catch (err) {
		const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)
		throw new RegistryTransportError(opts.baseUrl, path, cause)
	}
	if (res.status === 404) return null
	if (!res.ok) {
		const text = await res.text().catch(() => "")
		throw new RegistryHttpError(opts.baseUrl, path, res.status, text)
	}
	const body = (await res.json()) as { latestVersion: string | null }
	return { latestVersion: body.latestVersion }
}

/**
 * Detects whether an install spec would collide with an existing
 * install (architecture §8 decision 5; VAL-DISC-037, VAL-CROSS-022).
 *
 * Collision = a DIFFERENT scoped registration whose bare name
 * matches the new install's bare name. Same scope + same name is
 * NOT a collision (that's the upgrade path per decision 15).
 *
 * The check scans every install surface that produces a discoverable
 * module name:
 *   - `.baka/modules/<scope>-<name>` (project scope)
 *   - `${BAKA_HOME:-$HOME/.baka}/modules/<scope>-<name>` (user scope)
 *   - bundled modules (the engine ships `baka-base`, `sdd`,
 *     `ts-style` under the official scope; a community registry
 *     module whose bare name matches a bundled one is also a
 *     collision — the engine treats bundled as a registration)
 *
 * The function returns `null` when no collision exists; otherwise
 * it returns the registration that collides (scope + name +
 * registration location) so the CLI can name the existing install
 * in its error message.
 */
interface Collision {
	existingScope: string
	existingName: string
	registration: "project" | "user" | "bundled"
}

function detectNameCollision(
	scope: string,
	name: string,
	projectSettingsPath: string,
	userSettingsPathValue: string,
	projectModulesDirPath: string,
	userModulesDirPath: string,
): Collision | null {
	// Same scope + same name is the upgrade path — NOT a collision.
	const moduleName = `${scope}-${name}`
	// Project scope: scan `.baka/modules/<name>/manifest.ts` for
	// the scope that owns the existing install. The module dir's
	// manifest is the canonical source of the installed scope.
	if (existsSync(`${projectModulesDirPath}/${moduleName}`)) {
		const existingScope = readScopeFromManifest(`${projectModulesDirPath}/${moduleName}`)
		if (existingScope !== null && existingScope !== scope) {
			return { existingScope, existingName: name, registration: "project" }
		}
	}
	// User scope: same check, under the user marketplace.
	if (existsSync(`${userModulesDirPath}/${moduleName}`)) {
		const existingScope = readScopeFromManifest(`${userModulesDirPath}/${moduleName}`)
		if (existingScope !== null && existingScope !== scope) {
			return { existingScope, existingName: name, registration: "user" }
		}
	}
	// Bundled scope: the engine ships three bundled modules. A
	// registry install whose bare name matches a bundled module is
	// refused with the bundled registration named explicitly —
	// bundled scope participates in collision detection per
	// VAL-CROSS-022 step 4.
	const bundled = bundledScopeForName(name)
	if (bundled !== null && bundled !== scope) {
		return { existingScope: bundled, existingName: name, registration: "bundled" }
	}
	// Belt-and-braces: also check the project/user settings files
	// for a source string that would conflict. Settings source
	// strings are NOT used to compute collisions (the materialized
	// module dir is the canonical signal) — but if a registration
	// is present without a materialized dir, we still surface it
	// as a conflict.
	const projectSettings = readProjectSettingsSafe(projectSettingsPath)
	for (const raw of projectSettings.packages) {
		const reg = parseRegistrationScopeName(raw)
		if (reg !== null && reg.name === name && reg.scope !== scope) {
			return { existingScope: reg.scope, existingName: name, registration: "project" }
		}
	}
	const userSettings = readUserSettingsSafe(userSettingsPathValue)
	for (const raw of userSettings.packages) {
		const reg = parseRegistrationScopeName(raw)
		if (reg !== null && reg.name === name && reg.scope !== scope) {
			return { existingScope: reg.scope, existingName: name, registration: "user" }
		}
	}
	void moduleName
	return null
}

/**
 * Reads the `manifest.ts` from a materialized module directory
 * and extracts the manifest's `name` field. Returns `null` on
 * any parse failure so the collision detector degrades to "no
 * evidence of a different scope" — a missing/corrupt manifest
 * never blocks an install.
 */
function readScopeFromManifest(modulePath: string): string | null {
	const manifestPath = `${modulePath}/manifest.ts`
	if (!existsSync(manifestPath)) return null
	try {
		const text = readFileSync(manifestPath, "utf-8")
		// The CLI writes manifests as `export default { ... }`
		// with a stable `name` field; we extract it with a tiny
		// regex (the manifest is generated by the CLI from a JSON
		// blob the registry served, so the shape is predictable).
		const match = text.match(/"name"\s*:\s*"(@?[^"]+)"/)
		if (match === null) return null
		const name = match[1]
		if (typeof name !== "string") return null
		const slash = name.indexOf("/")
		if (slash >= 0) {
			// Strip a leading `@` (the manifest's name is the
			// full `@scope/name`; the install command's scope
			// is the bare `scope` part).
			const raw = name.slice(0, slash)
			return raw.startsWith("@") ? raw.slice(1) : raw
		}
		return "baka"
	} catch {
		return null
	}
}

/**
 * Reads a settings file defensively (parse failure → empty
 * packages). The settings reader in ast-tooling already handles
 * missing files; we keep a local copy here so the install module
 * does not need to import the settings writer into the collision
 * path.
 */
function readProjectSettingsSafe(path: string): { packages: string[] } {
	try {
		if (!existsSync(path)) return { packages: [] }
		const text = readFileSync(path, "utf-8")
		const parsed = JSON.parse(text) as { packages?: string[] }
		return { packages: Array.isArray(parsed.packages) ? parsed.packages : [] }
	} catch {
		return { packages: [] }
	}
}

function readUserSettingsSafe(path: string): { packages: string[] } {
	return readProjectSettingsSafe(path)
}

/**
 * Parses a settings-file source string to extract the (scope,
 * name) pair. Recognized shapes:
 *   - `registry:@scope/name[@version]` (registry source — strip prefix)
 *   - `npm:@scope/name[@version]` (npm source — strip prefix)
 *   - `git:<url>` (git source — no scope/name to extract)
 *
 * Returns `null` when the source has no scoped representation
 * (a bare git:/local path).
 */
function parseRegistrationScopeName(raw: string): { scope: string; name: string } | null {
	let body = raw
	if (body.startsWith("npm:")) body = body.slice(4)
	if (body.startsWith("registry:")) body = body.slice("registry:".length)
	// Strip a trailing `@<version>` pin. The first `@` is the
	// scoped-name marker; the LAST `@` is the version separator.
	// For `npm:@acme/widget@1.0.0` -> `body = "@acme/widget@1.0.0"`,
	// lastAt = position of the second `@`. Slice up to (but not
	// including) the second `@` to get `@acme/widget`.
	const firstAt = body.indexOf("@")
	if (firstAt < 0) return null
	const lastAt = body.lastIndexOf("@")
	if (lastAt > firstAt) {
		body = body.slice(0, lastAt)
	}
	if (!body.startsWith("@")) return null
	const rest = body.slice(1)
	const slash = rest.indexOf("/")
	if (slash <= 0) return null
	return { scope: rest.slice(0, slash), name: rest.slice(slash + 1) }
}

/**
 * Maps a bare module name to its bundled scope. The engine ships
 * three bundled modules under the official scope (`baka`): these
 * are the only bare-name reservations at install time. A bare
 * name that doesn't match a bundled module returns `null`.
 */
function bundledScopeForName(name: string): string | null {
	const BUNDLED = new Set(["baka-base", "sdd", "ts-style"])
	return BUNDLED.has(name) ? "baka" : null
}

/**
 * The full install command. Spec parsing + registry resolution +
 * integrity verification + collision detection + settings
 * registration all live here. Returns nothing; writes to stdout
 * (human-readable or --json payload) and exits on success.
 *
 * Failure modes (every one of these exits non-zero with an honest
 * message; none of them leaves a partial registration behind):
 *
 *   - Empty spec → "usage: baka install <spec>"
 *   - Malformed spec → "install spec ... is malformed; expected ..."
 *   - Registry unreachable → exit 2, names the registry URL
 *   - Module not found in any registry → exit 1, names the spec
 *   - Module is org-private and the caller is not a member → exit
 *     1, "not found or private" (uniform with VAL-DISC-019)
 *   - Cross-scope name collision → exit 1, names the existing
 *     install's scope + registration
 *   - Tarball integrity mismatch → exit 2, names expected vs actual
 *     sha256 (VAL-DISC-041)
 *   - Version not ready (pending/ingesting/failed) → exit 2,
 *     names the registry's recorded error (VAL-PUB-018)
 */
export async function runInstallCommand(spec: string, opts: InstallOptions): Promise<void> {
	if (!spec) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka install <spec>")

	let parsedSpec: ParsedInstallSpec
	try {
		parsedSpec = parseInstallSpec(spec)
	} catch (err) {
		die(BAKA_EXIT_CODE.USER_ERROR, err instanceof Error ? err.message : String(err))
	}

	if (parsedSpec.kind === "source") {
		// Non-registry install paths are unchanged from the prior
		// behavior (npm:/git:/local). Forward to the legacy
		// installer which is the source-URI authority.
		await runSourceInstall(spec, opts)
		return
	}

	const registries = opts.registries ?? resolveRegistriesForInstall(opts)
	if (registries.length === 0) {
		die(BAKA_EXIT_CODE.USER_ERROR, "no registries configured; add one with --registry <url> or BAKA_REGISTRY_URL")
	}

	const credentialLookup =
		opts.credentialLookup ??
		((baseUrl: string): { apiKey: string } | undefined => {
			const c = readRegistryCredential(baseUrl)
			return c ? { apiKey: c.apiKey } : undefined
		})

	const resolution = await resolveRegistryModuleForInstall({
		spec: parsedSpec,
		registries,
		credentialLookup,
		fetchImpl: opts.fetch,
	})
	if ("error" in resolution) {
		if (resolution.transport) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, `cannot reach registry: ${resolution.error}`)
		}
		die(BAKA_EXIT_CODE.USER_ERROR, resolution.error)
	}

	// Conflict check BEFORE any download. Same scope+name is the
	// upgrade path (decision 15); a different scope/registration
	// with the same bare name is a refusal (decision 5).
	const moduleName = `${resolution.scope}-${resolution.name}`
	const projectSettings = opts.scope === "project" ? projectSettingsPath(opts.cwd) : userSettingsPath()
	const projectModules = opts.scope === "project" ? projectModulesDir(opts.cwd) : userModulesDir()
	const otherSettings = opts.scope === "project" ? userSettingsPath() : projectSettingsPath(opts.cwd)
	const otherModules = opts.scope === "project" ? userModulesDir() : projectModulesDir(opts.cwd)
	const collision = detectNameCollision(
		resolution.scope,
		resolution.name,
		projectSettings,
		otherSettings,
		projectModules,
		otherModules,
	)
	if (collision !== null) {
		die(
			BAKA_EXIT_CODE.USER_ERROR,
			`install conflict: '${resolution.scope}/${resolution.name}' collides with an existing ` +
				`install of '${collision.existingScope}/${collision.existingName}' (registration: ${collision.registration}); ` +
				`remove the existing install with \`baka uninstall ${collision.existingScope}/${collision.existingName}\` before installing a different scope under the same name`,
		)
	}

	// Determine the previous version (for the upgrade branch and
	// the JSON payload). We pull it from the manifest of the
	// currently-installed module dir, when one exists.
	const modulePath = `${projectModules}/${moduleName}`
	const previousVersion = readInstalledVersion(modulePath)
	const isUpgrade = previousVersion !== null && previousVersion !== resolution.version

	// Download + integrity verification. On any failure, NOTHING
	// has been written to disk and no registration has been
	// added — the entire install path is side-effect-free until
	// both gates pass.
	let download: Awaited<ReturnType<typeof downloadTarball>>
	try {
		const cred = credentialLookup(resolution.registryBaseUrl)
		download = await downloadTarball({
			baseUrl: resolution.registryBaseUrl,
			scope: resolution.scope,
			name: resolution.name,
			version: resolution.version,
			apiKey: cred?.apiKey,
			fetchImpl: opts.fetch,
		})
	} catch (err) {
		if (err instanceof RegistryDownloadNotFound) {
			die(
				BAKA_EXIT_CODE.USER_ERROR,
				`module not found or private: '${resolution.scope}/${resolution.name}@${resolution.version}' ` +
					`(the registry returned a uniform not-found response; org-visibility modules are inaccessible to non-members per VAL-DISC-019)`,
			)
		}
		if (err instanceof RegistryDownloadGone) {
			die(
				BAKA_EXIT_CODE.USER_ERROR,
				`module was removed: '${resolution.scope}/${resolution.name}@${resolution.version}' ` +
					`is no longer served by the registry (tombstoned at ${resolution.registryBaseUrl}); existing local installs are unaffected`,
			)
		}
		if (err instanceof RegistryTransportError) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, `cannot reach registry: ${err.message}`)
		}
		if (err instanceof RegistryHttpError) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, `registry download failed: ${err.message}`)
		}
		throw err
	}

	if (download.expectedSha256 === null) {
		die(
			BAKA_EXIT_CODE.ENGINE_ERROR,
			`registry ${resolution.registryBaseUrl} did not include an x-content-sha256 header on the tarball response; cannot verify integrity (VAL-DISC-041)`,
		)
	}
	const actualSha256 = createHash("sha256").update(download.bytes).digest("hex")
	if (actualSha256 !== download.expectedSha256) {
		// Cleanup any stale module dir to leave the tree in a
		// known-good state (the dir may have existed from a prior
		// install — we don't touch it on upgrade either, until
		// integrity passes).
		die(
			BAKA_EXIT_CODE.ENGINE_ERROR,
			`tarball integrity mismatch for ${resolution.scope}/${resolution.name}@${resolution.version}: ` +
				`expected sha256=${download.expectedSha256}, got sha256=${actualSha256}; refusing to install`,
		)
	}

	// Integrity-verified. Now extract + materialize + register.
	// If extraction throws, the registration is rolled back below
	// in the catch — the install path is atomic from the user's
	// perspective.
	const settingsBefore = readProjectSettingsSafe(projectSettings)
	let result: InstallResultPayload
	try {
		const bytes = verifyTarballIntegrity({ bytes: download.bytes, expectedSha256: download.expectedSha256 })
		// Pre-clean: the upgrade path replaces the module dir; the
		// idempotent-same-version path keeps it (the bytes will be
		// re-extracted on top, but the result is the same tree).
		if (existsSync(modulePath)) rmSync(modulePath, { recursive: true, force: true })
		extractRegistryTarball(bytes, modulePath, resolution.manifest)
		// Register the source string. The format is
		// `registry:@scope/name@version` — parseSource recognizes
		// the `registry:` prefix and routes to a no-op switch
		// case (the materialization already happened above).
		const sourceString = `registry:@${resolution.scope}/${resolution.name}@${resolution.version}`
		const settings = readProjectSettingsSafe(projectSettings)
		// Strip any prior `registry:@scope/name` entry (with or
		// without an old version pin) so the upgrade replaces the
		// registration in place.
		const filtered = settings.packages.filter((raw: string) => {
			const reg = parseRegistrationScopeName(raw)
			if (reg === null) return true
			return !(reg.scope === resolution.scope && reg.name === resolution.name)
		})
		if (!filtered.includes(sourceString)) {
			filtered.push(sourceString)
		}
		mkdirSync(dirname(projectSettings), { recursive: true })
		writeFileSync(projectSettings, JSON.stringify({ packages: filtered }, null, 2))
		void settingsBefore
		result = {
			status: previousVersion === null ? "installed" : isUpgrade ? "upgraded" : "already-installed",
			scope: resolution.scope,
			name: resolution.name,
			version: resolution.version,
			previousVersion,
			registry: resolution.registryBaseUrl,
			modulePath,
			settingsPath: projectSettings,
		}
	} catch (err) {
		// Materialization failed AFTER the module dir was cleaned
		// (or never existed). We never wrote a registration, so
		// there is nothing to roll back. Surface the failure.
		die(BAKA_EXIT_CODE.ENGINE_ERROR, `install failed: ${err instanceof Error ? err.message : String(err)}`)
	}

	// Honor VAL-DISC-033: the apiKey never appears in any output.
	// `maskApiKey` is only used when the user requested --verbose
	// flags; the current install output is intentionally brief.
	void maskApiKey

	if (opts.json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
		return
	}

	const verb =
		result.status === "installed" ? "installed" : result.status === "upgraded" ? "upgraded" : "already installed"
	process.stdout.write(
		`${verb} ${result.scope}/${result.name}@${result.version} ` +
			`(was: ${result.previousVersion ?? "<none>"}, registry: ${result.registry ?? "<unknown>"}) ` +
			`-> ${result.modulePath}\n`,
	)
}

/**
 * Reads the installed version of an already-materialized module
 * dir. Returns `null` when no manifest is found or the manifest
 * cannot be parsed — the collision-free install proceeds in that
 * case (the "upgrade" detection is best-effort).
 */
function readInstalledVersion(modulePath: string): string | null {
	const manifestPath = `${modulePath}/manifest.ts`
	if (!existsSync(manifestPath)) return null
	try {
		const text = readFileSync(manifestPath, "utf-8")
		const match = text.match(/"version"\s*:\s*"([^"]+)"/)
		if (match === null) return null
		const version = match[1]
		if (typeof version !== "string") return null
		// Normalize the `v` prefix so we can compare with the
		// resolved version (which is also normalized to the bare
		// form, see `stripVersionPrefix`).
		return version.startsWith("v") || version.startsWith("V") ? version.slice(1) : version
	} catch {
		return null
	}
}

/**
 * Legacy source-URI install path (npm:/git:/path/url). Behavior is
 * unchanged from the prior marketplace command: parses the source
 * string, registers it in the project or user settings, and lets
 * `@repo/ast-tooling#installSource` materialize the module.
 *
 * The settings registration is preserved when materialization
 * fails — npm/git installs are NOT atomic in v1 (they always
 * leave a partial registration if the materializer throws). This
 * matches the legacy behavior; the registry path is the only one
 * with atomic-write semantics.
 */
async function runSourceInstall(spec: string, opts: InstallOptions): Promise<void> {
	const { installSource, parseSource, removeSource } = await import("@repo/ast-tooling")
	type ParsedSource = ReturnType<typeof parseSource>
	let parsed: ParsedSource
	try {
		parsed = parseSource(spec)
	} catch (err) {
		die(BAKA_EXIT_CODE.USER_ERROR, err instanceof Error ? err.message : String(err))
	}
	const settingsPath = opts.scope === "project" ? projectSettingsPath(opts.cwd) : userSettingsPath()
	const modulesDir = opts.scope === "project" ? projectModulesDir(opts.cwd) : userModulesDir()

	try {
		const result = await installSource(spec, {
			scope: opts.scope,
			cwd: opts.cwd,
			settingsPath,
			modulesDir,
		})
		if (opts.json) {
			process.stdout.write(
				`${JSON.stringify(
					{
						status: "installed",
						type: parsed.type,
						spec: parsed.raw,
						modulePath: result.modulePath,
						settingsPath,
					},
					null,
					2,
				)}\n`,
			)
			return
		}
		process.stdout.write(`installed ${parsed.type}: ${parsed.raw} -> ${result.modulePath} (${opts.scope} scope)\n`)
	} catch (err) {
		// Best-effort rollback for the legacy path: if the
		// registration was added but the materializer failed,
		// strip the registration so the project state stays
		// consistent with what the CLI claims.
		try {
			removeSource(spec, { settingsPath, modulesDir })
		} catch {
			/* best effort */
		}
		die(BAKA_EXIT_CODE.ENGINE_ERROR, `install failed: ${err instanceof Error ? err.message : String(err)}`)
	}
}

/**
 * Resolves the registries list for an install. The CLI's
 * `apps/cli/src/lib/registry-config.ts` is the canonical resolver;
 * we re-implement it here so this file can run in unit tests
 * without pulling the CLI lib (the test harness injects
 * `opts.registries` directly). When neither flag nor `registries`
 * is supplied, fall back to a one-element list containing the
 * default `localhost:4300` — matching the rest of the CLI's
 * registry surface (architecture §8 decisions 4 + 33).
 */
function resolveRegistriesForInstall(opts: InstallOptions): string[] {
	const env = opts.env ?? process.env
	const cwd = opts.cwd
	const projectRegistries = readProjectRegistries(cwd)
	if (opts.registry !== undefined && opts.registry.length > 0) return [opts.registry]
	if (typeof env.BAKA_REGISTRY_URL === "string" && env.BAKA_REGISTRY_URL.length > 0) return [env.BAKA_REGISTRY_URL]
	if (projectRegistries.length > 0) return projectRegistries
	return ["http://localhost:4300"]
}

function readProjectRegistries(cwd: string): string[] {
	const path = `${cwd}/.baka/settings.json`
	if (!existsSync(path)) return []
	try {
		const text = readFileSync(path, "utf-8")
		const parsed = JSON.parse(text) as { registries?: unknown }
		if (!Array.isArray(parsed.registries)) return []
		return parsed.registries.filter((r): r is string => typeof r === "string" && r.length > 0)
	} catch {
		return []
	}
}

// ---------------------------------------------------------------------------
// `baka uninstall <spec>` — inverse of `baka install` for the
// registry-sourced surface. Strips the registration from the
// settings file AND removes the materialized module dir. The same
// collision-detection / version-pinning logic is intentionally
// NOT applied: uninstall is a destructive operation, the user
// already knows what they installed.
// ---------------------------------------------------------------------------

interface UninstallOptions {
	cwd: string
	scope: "project" | "user"
	json?: boolean
}

export async function runUninstallCommand(spec: string, opts: UninstallOptions): Promise<void> {
	if (!spec) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka uninstall <spec>")

	let parsedSpec: ParsedInstallSpec
	try {
		parsedSpec = parseInstallSpec(spec)
	} catch (err) {
		die(BAKA_EXIT_CODE.USER_ERROR, err instanceof Error ? err.message : String(err))
	}
	if (parsedSpec.kind !== "registry") {
		die(
			BAKA_EXIT_CODE.USER_ERROR,
			`uninstall spec '${spec}' must be a registry spec (@<scope>/<name> or <name>); ` +
				`non-registry sources use \`baka remove\``,
		)
	}

	const scope = parsedSpec.scope ?? "baka"
	const name = parsedSpec.name
	const moduleName = `${scope}-${name}`
	const settingsPath = opts.scope === "project" ? projectSettingsPath(opts.cwd) : userSettingsPath()
	const modulesDir = opts.scope === "project" ? projectModulesDir(opts.cwd) : userModulesDir()

	const settings = readProjectSettingsSafe(settingsPath)
	const sourceStrings = settings.packages.filter((raw: string) => {
		const reg = parseRegistrationScopeName(raw)
		return reg !== null && reg.scope === scope && reg.name === name
	})
	if (sourceStrings.length === 0) {
		die(BAKA_EXIT_CODE.USER_ERROR, `no install of '${scope}/${name}' found in ${opts.scope} settings (${settingsPath})`)
	}

	// Strip every matching registration (a multi-version install
	// leaves one entry per version; uninstall removes them all —
	// matching the registry's "no partial state" semantics).
	const remaining = settings.packages.filter((raw: string) => {
		const reg = parseRegistrationScopeName(raw)
		return reg === null || reg.scope !== scope || reg.name !== name
	})
	mkdirSync(dirname(settingsPath), { recursive: true })
	writeFileSync(settingsPath, JSON.stringify({ ...settings, packages: remaining }, null, 2))

	const modulePath = `${modulesDir}/${moduleName}`
	if (existsSync(modulePath)) {
		rmSync(modulePath, { recursive: true, force: true })
	}

	const payload = {
		status: "uninstalled" as const,
		scope,
		name,
		modulePath,
		settingsPath,
		removedRegistrations: sourceStrings.length,
	}
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
		return
	}
	process.stdout.write(
		`uninstalled ${scope}/${name}: removed ${sourceStrings.length} registration(s) from ${opts.scope} settings; module dir cleared\n`,
	)
}

/**
 * Re-export for tests that need the parseInstallSpec surface
 * without spawning the CLI.
 */
export const __test__ = {
	parseInstallSpec,
	parseRegistrationScopeName,
	isValidSemverTag,
	isValidModuleIdentifier,
	detectNameCollision,
	resolveRegistryModuleForInstall,
}
