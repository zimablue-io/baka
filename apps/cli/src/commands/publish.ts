import { BAKA_EXIT_CODE } from "@repo/protocol"
import { die } from "../die"
import {
	maskApiKey,
	type PublishBody,
	pollVersionStatus,
	publishToRegistry,
	RegistryHttpError,
	RegistryTransportError,
} from "../lib/registry-client"
import { resolveSingleRegistryUrl } from "../lib/registry-config"
import { readRegistryCredential } from "../lib/registry-credentials"

/**
 * `baka publish <repo@tag> [--org <slug>] [--path <dir>] [--visibility org|public] [--registry <url>] [--json]`
 * (architecture §4.5, §5.1, milestone 5 cli-publish-org).
 *
 * Round-trip flow:
 *   1. Resolve the registry base URL (`--registry` > `BAKA_REGISTRY_URL` >
 *      `localhost:4300` default — same chain the rest of the registry
 *      surface uses; see `apps/cli/src/commands/registry.ts`).
 *   2. Read the per-registry API key from
 *      `${BAKA_HOME:-$HOME/.baka}/config.json`. Without a stored
 *      credential, exit 1 with an honest "no credential stored" message
 *      pointing at `baka registry login` — never silently fall back,
 *      never send a request without auth (the registry would 401 the
 *      request AND leak nothing about org existence; the CLI matches
 *      that surface by refusing pre-network, per VAL-DISC-007).
 *   3. POST `/v1/publish` with `{ repo, tag, org, packPath?,
 *      visibility? }`. Visibility defaults to `org` (private, per
 *      architecture §8 decision 30). A non-2xx response raises
 *      `RegistryHttpError` carrying the registry's typed message —
 *      the CLI surfaces it verbatim so a 403 (insufficient role per
 *      VAL-DISC-008) is distinguishable from a 422 (schema validation
 *      per VAL-PUB-020).
 *   4. Poll `GET /v1/packs/<scope>/<name>/<version>` until the
 *      version reaches `ready` or `failed` (500ms cadence, 60s
 *      ceiling). The polling loop respects the worker poll cycle so
 *      the CLI never out-races the worker.
 *   5. Print the terminal state. `failed` includes the worker error
 *      string (loadability gate diagnostic naming the failing recipe,
 *      per VAL-DISC-009). `ready` includes the pinned commit sha and
 *      content hash so the caller can pin against the registry's
 *      own record (VAL-DISC-006).
 *
 * The CLI never mutates the local project tree on the publish path —
 * publishing is a registry-side operation; the engine's plan/apply
 * surface is the only place that touches local files.
 */

interface PublishOptions {
	org?: string
	path?: string
	visibility?: "org" | "public"
	registry?: string
	json?: boolean
	timeoutMs?: number
}

interface PublishResultPayload {
	status: "pending" | "ingesting" | "ready" | "failed"
	scope: string
	name: string
	version: string
	commitSha: string
	contentHash: string
	error: string | null
	screeningVerdict: string | null
}

function resolveBaseUrl(flagValue: string | undefined): string {
	return resolveSingleRegistryUrl(flagValue)
}

/**
 * Splits `<repo>@<tag>` into its parts. The spec accepts:
 *   - `https://github.com/org/repo@v1.0.0`
 *   - `git@github.com:org/repo.git@v1.0.0`
 *   - `file:///tmp/repo@v1.0.0`
 * The last `@` after the URL scheme/host separator is the split
 * point so URL-embedded credentials (`user:pass@host`) parse
 * correctly.
 */
function parseRepoAtTagSpec(spec: string): { repo: string; tag: string } {
	const trimmed = spec.trim()
	if (trimmed.length === 0) {
		throw new Error("publish spec must be in the form <repo>@<tag>")
	}
	const schemeEnd = trimmed.indexOf("://")
	const searchStart = trimmed.indexOf("?")
	const hashStart = trimmed.indexOf("#")
	let boundary = -1
	if (schemeEnd >= 0) {
		const schemeTail = trimmed.slice(schemeEnd + 3)
		const atInSchemeTail = schemeTail.lastIndexOf("@")
		if (atInSchemeTail >= 0) {
			boundary = schemeEnd + 3 + atInSchemeTail
		}
	}
	if (boundary < 0) {
		boundary = trimmed.lastIndexOf("@")
	}
	if (boundary <= 0 || boundary === trimmed.length - 1) {
		throw new Error(
			`publish spec '${trimmed}' must be in the form <repo>@<tag> (the @ separates the repository URL from the git tag)`,
		)
	}
	const repo = trimmed.slice(0, boundary)
	const tag = trimmed.slice(boundary + 1)
	if (repo.length === 0 || tag.length === 0) {
		throw new Error(`publish spec '${trimmed}' must be in the form <repo>@<tag>; both parts must be non-empty`)
	}
	if (searchStart >= 0 && searchStart < boundary) {
		throw new Error(`publish spec '${trimmed}' contains a '?' before the @tag separator; check the URL shape`)
	}
	if (hashStart >= 0 && hashStart < boundary) {
		throw new Error(`publish spec '${trimmed}' contains a '#' before the @tag separator; check the URL shape`)
	}
	return { repo, tag }
}

export async function runPublishCommand(spec: string, opts: PublishOptions): Promise<void> {
	if (!spec)
		die(
			BAKA_EXIT_CODE.BAD_INPUT,
			"usage: baka publish <repo>@<tag> [--org <slug>] [--path <dir>] [--visibility org|public]",
		)

	let parsed: { repo: string; tag: string }
	try {
		parsed = parseRepoAtTagSpec(spec)
	} catch (err) {
		die(BAKA_EXIT_CODE.BAD_INPUT, err instanceof Error ? err.message : String(err))
	}

	const baseUrl = resolveBaseUrl(opts.registry)
	const credential = readRegistryCredential(baseUrl)
	if (!credential) {
		die(
			BAKA_EXIT_CODE.BAD_INPUT,
			`no credential stored for ${baseUrl}. Run \`baka registry login --token <key>\` to authenticate, then retry.`,
		)
	}

	if (!opts.org || opts.org.length === 0) {
		die(BAKA_EXIT_CODE.BAD_INPUT, "publish requires --org <slug> (the registry namespace to publish into)")
	}

	const body: PublishBody = {
		repo: parsed.repo,
		tag: parsed.tag,
		org: opts.org,
		...(opts.path !== undefined && opts.path.length > 0 ? { packPath: opts.path } : {}),
		...(opts.visibility !== undefined ? { visibility: opts.visibility } : {}),
	}

	let accepted: Awaited<ReturnType<typeof publishToRegistry>>
	try {
		accepted = await publishToRegistry({ baseUrl, apiKey: credential.apiKey, body })
	} catch (err) {
		if (err instanceof RegistryTransportError) {
			die(
				BAKA_EXIT_CODE.FAILED,
				`cannot reach registry at ${baseUrl}: ${err.message.split(":").slice(-1)[0]?.trim() ?? "transport failure"}`,
			)
		}
		if (err instanceof RegistryHttpError) {
			// Surface the registry's typed envelope verbatim. A 422
			// names the failing field; a 403 names the role
			// requirement; a 401 names the credential rejection.
			// The CLI does not invent context the registry did
			// not provide.
			const message = extractErrorMessage(err.message)
			die(httpStatusToExitCode(err.status), `${message} (key ${maskApiKey(credential.apiKey)})`)
		}
		throw err
	}

	const terminal = await pollVersionStatus({
		baseUrl,
		apiKey: credential.apiKey,
		scope: accepted.scope,
		name: accepted.name,
		version: accepted.version,
		timeoutMs: opts.timeoutMs ?? 60_000,
	})

	const payload: PublishResultPayload = {
		status: terminal.status,
		scope: accepted.scope,
		name: accepted.name,
		version: terminal.version,
		commitSha: terminal.commitSha,
		contentHash: terminal.contentHash,
		error: terminal.error,
		screeningVerdict: terminal.screening?.verdict ?? null,
	}

	if (opts.json) {
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
		if (terminal.status === "failed") {
			process.exit(BAKA_EXIT_CODE.FAILED)
		}
		return
	}

	if (terminal.status === "ready") {
		process.stdout.write(`published ${accepted.scope}/${accepted.name}@${terminal.version}\n`)
		process.stdout.write(`  status:     ready\n`)
		process.stdout.write(`  commit:     ${terminal.commitSha}\n`)
		process.stdout.write(`  contentSha: ${terminal.contentHash}\n`)
		if (terminal.screening?.verdict) {
			process.stdout.write(`  screening:  ${terminal.screening.verdict}\n`)
		}
		return
	}

	if (terminal.status === "failed") {
		process.stderr.write(`publish failed for ${accepted.scope}/${accepted.name}@${terminal.version}\n`)
		if (terminal.error) {
			process.stderr.write(`  error: ${terminal.error}\n`)
		}
		process.exit(BAKA_EXIT_CODE.FAILED)
		return
	}

	// pending / ingesting after the polling ceiling is honest — the
	// worker is still chewing. Surface it instead of claiming success.
	process.stderr.write(
		`publish timed out waiting for terminal status: ${accepted.scope}/${accepted.name}@${terminal.version} is ${terminal.status}\n`,
	)
	process.exit(BAKA_EXIT_CODE.FAILED)
}

/**
 * Strips the registry client's `registry <path> failed: HTTP <status>` prefix
 * down to the registry's own message body. The CLI surfaces that message
 * so a 403 role-error carries the actual rule, not the HTTP envelope.
 */
function extractErrorMessage(raw: string): string {
	const idx = raw.indexOf(":")
	if (idx < 0) return raw
	return raw.slice(idx + 1).trim()
}

/**
 * Maps HTTP status from the registry's publish endpoint to a CLI exit
 * code. 4xx → BAD_INPUT (the user provided bad input or lacks
 * permission); 5xx and transport → FAILED. A 401 / 403 from the
 * publish endpoint is a credential or role failure, both USER_ERRORs
 * the user can act on by re-running `baka registry login` or asking
 * the org owner for promotion.
 */
function httpStatusToExitCode(status: number): number {
	if (status === 401 || status === 403 || status === 404 || status === 422) {
		return BAKA_EXIT_CODE.BAD_INPUT
	}
	return BAKA_EXIT_CODE.FAILED
}
