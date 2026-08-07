import { z } from "zod"

/**
 * Per-registry credential contract (architecture §8 decision 4 + decision 33).
 *
 * The CLI stores one credential per registry base URL in the user
 * config file `${BAKA_HOME:-$HOME/.baka}/config.json`, under a top-level
 * `registries` map keyed by the normalized registry URL:
 *
 *   {
 *     "worker": { ... },
 *     "validator": { ... },
 *     "registries": {
 *       "http://localhost:4300": { "apiKey": "<key>" },
 *       "http://other:4310":     { "apiKey": "<key>" }
 *     }
 *   }
 *
 * `apiKey` is the only field in v1: GitHub OAuth issues session cookies,
 * but the CLI surfaces a long-lived API key (created through the
 * registry's API-key endpoint) and stores it here. New credential
 * mechanisms (refresh tokens, OAuth bearer) extend this schema; do not
 * introduce a parallel key shape.
 */
export const RegistryCredentialSchema = z.object({
	apiKey: z.string().min(1),
})

export type RegistryCredential = z.infer<typeof RegistryCredentialSchema>

/**
 * Registry config map shape — the `registries` section of the user
 * config file. Keys are normalized registry base URLs; values are
 * the credentials issued by that registry.
 */
export const RegistryConfigMapSchema = z.record(z.string(), RegistryCredentialSchema)

export type RegistryConfigMap = z.infer<typeof RegistryConfigMapSchema>

/**
 * Normalizes a registry base URL for use as a stable storage key
 * (architecture §8 decision 4). Two URLs that resolve to the same
 * origin (scheme + host + port) MUST produce the same key so a user
 * is not silently creating duplicate credentials. Trailing slashes
 * are dropped; the scheme and host are lowercased; the path is
 * preserved verbatim.
 *
 * Examples:
 *   - `http://localhost:4300`        → `http://localhost:4300`
 *   - `http://localhost:4300/`       → `http://localhost:4300`
 *   - `HTTP://Localhost:4300`        → `http://localhost:4300`
 *   - `http://localhost:4300/base/`  → `http://localhost:4300/base`
 *
 * Throws when the input is not a valid URL — the caller is expected
 * to validate the URL before passing it here (e.g. the CLI's --registry
 * flag is parsed against this contract at the command boundary).
 */
export function normalizeRegistryUrl(url: string): string {
	const trimmed = url.trim()
	if (trimmed.length === 0) throw new Error("registry URL must not be empty")
	let parsed: URL
	try {
		parsed = new URL(trimmed)
	} catch {
		throw new Error(`invalid registry URL: ${url}`)
	}
	// URL already lowercases the host. Lowercase the scheme explicitly
	// for symmetry (URL keeps it lowercased by default; this is a
	// belt-and-braces guard against future URL polyfill quirks).
	const scheme = parsed.protocol.toLowerCase()
	const host = parsed.host.toLowerCase()
	const path = parsed.pathname.replace(/\/+$/, "")
	return `${scheme}//${host}${path}`
}
