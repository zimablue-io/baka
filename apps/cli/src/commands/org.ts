import { BAKA_EXIT_CODE, normalizeRegistryUrl } from "@repo/protocol"
import {
	createOrg,
	inviteToOrg,
	listOrgs,
	maskApiKey,
	RegistryHttpError,
	RegistryTransportError,
} from "../lib/registry-client"
import { readRegistryCredential } from "../lib/registry-credentials"

/**
 * `baka org create <slug> [--name <name>] [--registry <url>] [--json]`
 * `baka org list [--registry <url>] [--json]`
 * `baka org invite <slug> <email> [--role owner|admin|member] [--registry <url>] [--json]`
 *
 * Thin wrappers over the registry's `/v1/orgs/*` surface (architecture
 * §4.4, §5.1, milestone 5 cli-publish-org). Round-trip honors
 * VAL-DISC-014 + VAL-CROSS-003: the CLI is the documented entry point,
 * the API stays the same surface, and the duplicate-slug /
 * unknown-invitee errors surface verbatim from the registry's typed
 * envelope so the caller can branch on them.
 *
 * No credential → exit 1 with an honest "no credential stored" message
 * pointing at `baka registry login`. The CLI never silently falls
 * back to anonymous calls (the registry would 401 the request; the
 * CLI matches that contract by refusing pre-network, per VAL-DISC-007).
 */

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

function resolveBaseUrl(flagValue: string | undefined): string {
	const raw = flagValue && flagValue.length > 0 ? flagValue : (process.env.BAKA_REGISTRY_URL ?? "http://localhost:4300")
	return normalizeRegistryUrl(raw)
}

/**
 * Returns the resolved base URL and the stored API key. Exits USER_ERROR
 * when no credential is stored for the URL — every subcommand below
 * requires an authenticated session.
 */
function requireCredential(registryFlag: string | undefined): { baseUrl: string; apiKey: string } {
	const baseUrl = resolveBaseUrl(registryFlag)
	const credential = readRegistryCredential(baseUrl)
	if (!credential) {
		die(
			BAKA_EXIT_CODE.USER_ERROR,
			`no credential stored for ${baseUrl}. Run \`baka registry login --token <key>\` to authenticate, then retry.`,
		)
	}
	return { baseUrl, apiKey: credential.apiKey }
}

// ---------------------------------------------------------------------------
// baka org create <slug> [--name <name>]
// ---------------------------------------------------------------------------

interface OrgCreateOptions {
	name?: string
	registry?: string
	json?: boolean
}

export async function runOrgCreateCommand(slug: string, opts: OrgCreateOptions): Promise<void> {
	if (!slug) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka org create <slug> [--name <name>]")
	const name = opts.name && opts.name.length > 0 ? opts.name : slug
	const { baseUrl, apiKey } = requireCredential(opts.registry)

	let result: Awaited<ReturnType<typeof createOrg>>
	try {
		result = await createOrg({ baseUrl, apiKey, body: { name, slug } })
	} catch (err) {
		dieOnRegistryError(err, baseUrl, apiKey, "/v1/orgs")
		return
	}

	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ id: result.id, slug: result.slug, name: result.name }, null, 2)}\n`)
		return
	}
	process.stdout.write(`created org ${result.slug} (id=${result.id})\n`)
}

// ---------------------------------------------------------------------------
// baka org list
// ---------------------------------------------------------------------------

interface OrgListOptions {
	registry?: string
	json?: boolean
}

export async function runOrgListCommand(opts: OrgListOptions): Promise<void> {
	const { baseUrl, apiKey } = requireCredential(opts.registry)

	let rows: Awaited<ReturnType<typeof listOrgs>>
	try {
		rows = await listOrgs({ baseUrl, apiKey })
	} catch (err) {
		dieOnRegistryError(err, baseUrl, apiKey, "/v1/orgs")
		return
	}

	if (opts.json) {
		process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
		return
	}
	if (rows.length === 0) {
		process.stdout.write("no orgs; use `baka org create <slug>` to make one\n")
		return
	}
	process.stdout.write(`${rows.length} org(s):\n`)
	for (const row of rows) {
		process.stdout.write(`  ${row.slug}\t${row.name}\t(role=${row.role})\n`)
	}
}

// ---------------------------------------------------------------------------
// baka org invite <slug> <email> [--role owner|admin|member]
// ---------------------------------------------------------------------------

interface OrgInviteOptions {
	role?: "owner" | "admin" | "member"
	registry?: string
	json?: boolean
}

export async function runOrgInviteCommand(slug: string, email: string, opts: OrgInviteOptions): Promise<void> {
	if (!slug) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka org invite <slug> <email> [--role owner|admin|member]")
	if (!email) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka org invite <slug> <email> [--role owner|admin|member]")
	const role = opts.role ?? "member"
	if (role !== "owner" && role !== "admin" && role !== "member") {
		die(BAKA_EXIT_CODE.USER_ERROR, `invalid role '${role}'; expected one of: owner, admin, member`)
	}
	const { baseUrl, apiKey } = requireCredential(opts.registry)

	let result: Awaited<ReturnType<typeof inviteToOrg>>
	try {
		result = await inviteToOrg({ baseUrl, apiKey, slug, body: { email, role } })
	} catch (err) {
		dieOnRegistryError(err, baseUrl, apiKey, `/v1/orgs/${slug}/invite`)
		return
	}

	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ invitationId: result.id, slug, email, role }, null, 2)}\n`)
		return
	}
	process.stdout.write(`invited ${email} to ${slug} (role=${role}, invitation=${result.id})\n`)
}

/**
 * Surfaces a registry error verbatim. 4xx → USER_ERROR (the user
 * supplied a bad slug, an unknown invitee, etc.); 5xx + transport →
 * ENGINE_ERROR. The masked key prefix is appended so a 401/403
 * carries the same "rejected by the registry" framing the other
 * CLI commands use, never the raw key.
 */
function dieOnRegistryError(err: unknown, baseUrl: string, apiKey: string, path: string): never {
	if (err instanceof RegistryTransportError) {
		die(
			BAKA_EXIT_CODE.ENGINE_ERROR,
			`cannot reach registry at ${baseUrl} (${path}): ${err.message.split(":").slice(-1)[0]?.trim() ?? "transport failure"}`,
		)
	}
	if (err instanceof RegistryHttpError) {
		const message = stripRegistryErrorPrefix(err.message)
		die(httpStatusToExitCode(err.status), `${message} (key ${maskApiKey(apiKey)})`)
	}
	const message = err instanceof Error ? err.message : String(err)
	die(BAKA_EXIT_CODE.ENGINE_ERROR, `unexpected registry error (${path}): ${message}`)
}

function stripRegistryErrorPrefix(raw: string): string {
	const idx = raw.indexOf(":")
	if (idx < 0) return raw
	return raw.slice(idx + 1).trim()
}

function httpStatusToExitCode(status: number): number {
	if (status === 401 || status === 403 || status === 404 || status === 409 || status === 422) {
		return BAKA_EXIT_CODE.USER_ERROR
	}
	return BAKA_EXIT_CODE.ENGINE_ERROR
}
