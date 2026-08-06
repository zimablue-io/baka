/**
 * Repo URL validation (architecture §4.5, VAL-PUB-021).
 *
 * The publish body accepts a `repo` field that the worker later
 * shallow-clones via system git. At publish time the registry MUST
 * reject malformed URLs BEFORE creating any `module_versions` row
 * so a typo doesn't pollute the catalog with a phantom version.
 *
 * Accepted shapes:
 *   - HTTPS/HTTP git URL:  `https://github.com/org/repo`
 *   - git protocol URL:    `git://github.com/org/repo`
 *   - SSH (scp-style):    `git@github.com:org/repo.git`
 *   - local file path:     `file:///abs/path/to/bare.git` (hermetic
 *     tests use this form; production deploys use https/git/ssh)
 *
 * Rejected shapes (representative, not exhaustive):
 *   - `"not a url"` — not parseable
 *   - `"ftp://x/y"` — wrong scheme
 *   - empty string
 *   - paths without a host (e.g. `"/foo/bar"`)
 */

const ACCEPTED_Schemes = new Set(["https:", "http:", "git:", "ssh:", "file:"])

const SSH_USER_AT_HOST_PATTERN = /^[\w.-]+@[\w.-]+:[~/\w.-]+$/

export function isValidRepoUrl(input: unknown): input is string {
	if (typeof input !== "string" || input.length === 0) return false
	// Try a URL parse first (HTTPS / HTTP / git:// / ssh:// / file://).
	try {
		const parsed = new URL(input)
		if (!ACCEPTED_Schemes.has(parsed.protocol)) return false
		// file:// URLs carry the path as `parsed.pathname` rather than
		// a hostname; skip the hostname check for those.
		if (parsed.protocol !== "file:" && parsed.hostname.length === 0) return false
		return true
	} catch {
		// Not a URL — fall through to the SSH scp-style check.
	}
	return SSH_USER_AT_HOST_PATTERN.test(input)
}
