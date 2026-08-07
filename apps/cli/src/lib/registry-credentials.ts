import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { userConfigPath } from "@repo/agent-engine"
import { normalizeRegistryUrl, type RegistryConfigMap, type RegistryCredential } from "@repo/protocol"

/**
 * Per-registry credential store (architecture §8 decision 4 + decision 33).
 *
 * Reads and writes the `registries` section of the user config file
 * `${BAKA_HOME:-$HOME/.baka}/config.json`. The file's other sections
 * (`worker`, `validator`) are read through agent-engine's role store
 * and are preserved verbatim by every read-modify-write cycle here.
 *
 * Keys in the `registries` map are the normalized registry base URL
 * (see `normalizeRegistryUrl`). A malformed or corrupt user config
 * raises an honest, typed error naming the config path — the
 * underlying file is never silently treated as empty (the role store
 * follows the same contract, see `packages/agent-engine/src/config/store.ts`).
 *
 * Note: this module does NOT call zod schemas at runtime. The zod
 * schemas in `@repo/protocol` exist for the contract surface; the CLI
 * uses lightweight manual validation here because the bundled CLI does
 * not depend on zod (and the tsup bundler renames re-exported schemas
 * in a way that breaks runtime references). Manual checks below match
 * the schema definitions exactly so the wire shape is identical.
 */

function readUserConfigRoot(): Record<string, unknown> {
	const path = userConfigPath()
	if (!existsSync(path)) return {}
	const text = readFileSync(path, "utf-8").trim()
	if (text === "") return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		throw new Error(`user config at ${path} is corrupt; run \`baka init\` to repair.`)
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		// The role store treats non-object roots as empty; mirror that
		// behavior here so a stray array or null never throws on a
		// read path that should be lossless.
		return {}
	}
	return parsed as Record<string, unknown>
}

function writeUserConfigRoot(root: Record<string, unknown>): void {
	const path = userConfigPath()
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify(root, null, 2), "utf-8")
}

function isCredential(value: unknown): value is RegistryCredential {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		typeof (value as { apiKey?: unknown }).apiKey === "string" &&
		(value as { apiKey: string }).apiKey.length > 0
	)
}

/**
 * Reads the full `registries` map from the user config. Returns an
 * empty object when no registry credentials are stored. The map's keys
 * are normalized registry base URLs (so callers can pass either form
 * to `readRegistryCredential` and get the same result).
 */
export function readRegistryCredentials(): RegistryConfigMap {
	const root = readUserConfigRoot()
	const raw = root.registries
	if (raw === undefined) return {}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`user config at ${userConfigPath()}: "registries" must be an object`)
	}
	const out: RegistryConfigMap = {}
	for (const [url, value] of Object.entries(raw as Record<string, unknown>)) {
		const normalized = normalizeRegistryUrl(url)
		if (!isCredential(value)) {
			throw new Error(`user config at ${userConfigPath()}: invalid credential for registry "${url}"`)
		}
		out[normalized] = value
	}
	return out
}

/**
 * Reads the credential stored for `url`. The URL is normalized before
 * lookup, so `http://localhost:4300` and `http://localhost:4300/`
 * resolve to the same entry. Returns `undefined` when no credential
 * is stored for that registry.
 */
export function readRegistryCredential(url: string): RegistryCredential | undefined {
	const normalized = normalizeRegistryUrl(url)
	return readRegistryCredentials()[normalized]
}

/**
 * Writes (or removes, when `credential === undefined`) the credential
 * for `url`. The URL is normalized before storage so subsequent reads
 * find it under any equivalent form. Other keys in the user config
 * (role blocks) are preserved verbatim.
 *
 * When `credential === undefined` and removing the entry leaves the
 * `registries` map empty, the `registries` key itself is removed from
 * the on-disk JSON so the file reflects "no credentials stored"
 * verbatim rather than `{ "registries": {} }`.
 */
export function writeRegistryCredential(url: string, credential: RegistryCredential | undefined): void {
	if (credential !== undefined && !isCredential(credential)) {
		throw new Error(`credential for ${url} is invalid (apiKey must be a non-empty string)`)
	}
	const normalized = normalizeRegistryUrl(url)
	const root = readUserConfigRoot()
	const existing = root.registries
	const registries: Record<string, unknown> =
		existing !== undefined && existing !== null && typeof existing === "object" && !Array.isArray(existing)
			? { ...(existing as Record<string, unknown>) }
			: {}
	if (credential === undefined) {
		delete registries[normalized]
	} else {
		registries[normalized] = credential
	}
	if (Object.keys(registries).length === 0) {
		delete root.registries
	} else {
		root.registries = registries
	}
	writeUserConfigRoot(root)
}
