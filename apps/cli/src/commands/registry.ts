import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { BAKA_EXIT_CODE } from "@repo/protocol"
import { die } from "../die"
import {
	getPackDetail,
	getPackPreviews,
	getRecipePreview,
	getVersionDetail,
	maskApiKey,
	RegistryHttpError,
	RegistryTransportError,
	whoami,
} from "../lib/registry-client"
import { resolveSingleRegistryUrl } from "../lib/registry-config"
import { readRegistryCredential, readRegistryCredentials, writeRegistryCredential } from "../lib/registry-credentials"

/**
 * `baka registry *` subcommand (architecture §8 decisions 4, 33; milestone 5).
 *
 * - `login [--token <key>]` — store a credential for one registry.
 *   With `--token`, the key is verified against `/api/auth/get-session`
 *   and stored on success. Without `--token`, the browser flow prints
 *   a URL the user opens in their browser; the registry's CLI auth
 *   page redirects back to a localhost callback the CLI owns.
 * - `logout` — remove the credential for one registry.
 * - `whoami` — print the authenticated identity for one registry.
 *
 * Credentials are scoped per registry base URL (decision 4) and stored
 * in `${BAKA_HOME:-$HOME/.baka}/config.json` (decision 33). Keys are
 * never echoed in any output or log (VAL-DISC-033).
 */

function resolveRegistryUrl(flagValue: string | undefined): string {
	return resolveSingleRegistryUrl(flagValue)
}

interface LoginOptions {
	token?: string
	registry?: string
}

interface LogoutOptions {
	registry?: string
}

interface WhoamiOptions {
	registry?: string
}

// ---------------------------------------------------------------------------
// baka registry login [--token <key>]
// ---------------------------------------------------------------------------

export async function runRegistryLogin(opts: LoginOptions): Promise<void> {
	const baseUrl = resolveRegistryUrl(opts.registry)
	if (opts.token && opts.token.length > 0) {
		await loginWithToken(opts.token, baseUrl)
		return
	}
	await loginWithBrowserFlow(baseUrl)
}

async function loginWithToken(token: string, baseUrl: string): Promise<void> {
	let identity: Awaited<ReturnType<typeof whoami>>
	try {
		identity = await whoami({ baseUrl, apiKey: token })
	} catch (err) {
		if (err instanceof RegistryTransportError) {
			die(
				BAKA_EXIT_CODE.FAILED,
				`cannot verify key: registry unreachable at ${baseUrl} (${err.message.split(":").slice(-1)[0]?.trim() ?? "transport failure"})`,
			)
		}
		if (err instanceof RegistryHttpError) {
			die(BAKA_EXIT_CODE.FAILED, `cannot verify key: registry returned HTTP ${err.status}`)
		}
		throw err
	}
	if (!identity) {
		die(
			BAKA_EXIT_CODE.BAD_INPUT,
			`registry at ${baseUrl} rejected the key (HTTP 401). Run \`baka registry login --token <key>\` with a valid key from \`POST /api/auth/api-key/create\`.`,
		)
	}
	writeRegistryCredential(baseUrl, { apiKey: token })
	console.log(
		`logged in to ${baseUrl} as ${identity.name ?? identity.email ?? identity.userId} (key ${maskApiKey(token)})`,
	)
}

// ---------------------------------------------------------------------------
// Browser flow (architecture §4.4, decision §8.32).
//
// The CLI starts a localhost HTTP callback server, prints a URL the
// user opens in their browser, and waits for the registry's CLI
// auth page to redirect back with the issued API key. The state
// parameter is generated locally and verified on the callback to
// prevent an open-redirect from another browser tab landing on the
// callback and writing a foreign-supplied key.
//
// Cancelling the flow (closing the browser, never completing) exits
// non-zero with a clean "login not completed" message (VAL-DISC-032).
// The CLI never writes a partial credential.
// ---------------------------------------------------------------------------

const BROWSER_CALLBACK_PATH = "/baka-cli-callback"
const BROWSER_FLOW_TIMEOUT_MS = 5 * 60 * 1000

async function loginWithBrowserFlow(baseUrl: string): Promise<void> {
	const state = randomBytes(16).toString("hex")
	const callbackUrl = await startCallbackServer(state, baseUrl)
	const authUrl = `${baseUrl}/cli-auth?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}`
	process.stdout.write(`opening: ${authUrl}\n`)
	process.stdout.write(`(if your browser does not open automatically, paste the URL above into a browser)\n`)
	const received = await waitForCallback(BROWSER_FLOW_TIMEOUT_MS)
	if (!received) {
		stopCallbackServer()
		die(
			BAKA_EXIT_CODE.BAD_INPUT,
			`login not completed: timed out waiting for the registry to redirect back to ${callbackUrl}. Run \`baka registry login --token <key>\` to paste a key directly.`,
		)
	}
	stopCallbackServer()
	if (received.state !== state) {
		die(
			BAKA_EXIT_CODE.BAD_INPUT,
			`login not completed: state mismatch (expected ${state}, got ${received.state ?? "<missing>"}). Run \`baka registry login --token <key>\` to paste a key directly.`,
		)
	}
	if (!received.apiKey) {
		die(
			BAKA_EXIT_CODE.BAD_INPUT,
			`login not completed: the registry's redirect did not include an API key. Run \`baka registry login --token <key>\` to paste a key directly.`,
		)
	}
	writeRegistryCredential(baseUrl, { apiKey: received.apiKey })
	const masked = maskApiKey(received.apiKey)
	console.log(`logged in to ${baseUrl} (key ${masked})`)
}

interface BrowserFlowPending {
	state?: string
	apiKey?: string
}

interface BrowserFlowResult {
	state?: string
	apiKey?: string
}

let callbackServer: ReturnType<typeof createServer> | null = null
let callbackResolve: ((value: BrowserFlowResult | null) => void) | null = null
let callbackTimer: NodeJS.Timeout | null = null

function startCallbackServer(expectedState: string, _baseUrl: string): Promise<string> {
	return new Promise((resolveStart, rejectStart) => {
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			try {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				if (url.pathname !== BROWSER_CALLBACK_PATH) {
					res.statusCode = 404
					res.end("not found")
					return
				}
				const state = url.searchParams.get("state") ?? undefined
				const apiKey = url.searchParams.get("key") ?? url.searchParams.get("apiKey") ?? undefined
				const pending: BrowserFlowPending = { state, apiKey }
				res.setHeader("content-type", "text/html; charset=utf-8")
				res.end(
					`<!doctype html><meta charset="utf-8"><title>baka login complete</title>` +
						`<body style="font-family:system-ui;padding:2rem;max-width:36rem">` +
						`<h1 style="font-size:1.2rem">login complete</h1>` +
						`<p>You can close this tab and return to the terminal.</p>` +
						`<p style="color:#666;font-size:0.85rem">state=${expectedState.slice(0, 8)}…</p>` +
						`</body>`,
				)
				if (callbackResolve) callbackResolve(pending)
			} catch {
				res.statusCode = 500
				res.end("internal error")
			}
		})
		server.on("error", rejectStart)
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address()
			if (typeof addr !== "object" || addr === null) {
				server.close()
				rejectStart(new Error("failed to bind callback server"))
				return
			}
			callbackServer = server
			resolveStart(`http://127.0.0.1:${addr.port}${BROWSER_CALLBACK_PATH}`)
		})
	})
}

function waitForCallback(timeoutMs: number): Promise<BrowserFlowResult | null> {
	return new Promise((resolve) => {
		callbackResolve = resolve
		callbackTimer = setTimeout(() => {
			if (callbackResolve) {
				callbackResolve(null)
				callbackResolve = null
			}
		}, timeoutMs)
	})
}

function stopCallbackServer(): void {
	if (callbackTimer) {
		clearTimeout(callbackTimer)
		callbackTimer = null
	}
	callbackResolve = null
	if (callbackServer) {
		callbackServer.close()
		callbackServer = null
	}
}

// ---------------------------------------------------------------------------
// baka registry logout
// ---------------------------------------------------------------------------

export function runRegistryLogout(opts: LogoutOptions): void {
	const baseUrl = resolveRegistryUrl(opts.registry)
	const existing = readRegistryCredential(baseUrl)
	if (!existing) {
		console.log(`no credential stored for ${baseUrl}`)
		return
	}
	writeRegistryCredential(baseUrl, undefined)
	console.log(`removed credential for ${baseUrl}`)
}

// ---------------------------------------------------------------------------
// baka registry whoami
// ---------------------------------------------------------------------------

export async function runRegistryWhoami(opts: WhoamiOptions): Promise<void> {
	const baseUrl = resolveRegistryUrl(opts.registry)
	const credential = readRegistryCredential(baseUrl)
	if (!credential) {
		die(BAKA_EXIT_CODE.BAD_INPUT, `no credential stored for ${baseUrl}. Run \`baka registry login\` to authenticate.`)
	}
	let identity: Awaited<ReturnType<typeof whoami>>
	try {
		identity = await whoami({ baseUrl, apiKey: credential.apiKey })
	} catch (err) {
		if (err instanceof RegistryTransportError) {
			die(
				BAKA_EXIT_CODE.FAILED,
				`registry at ${baseUrl} is unreachable: ${err.message.split(":").slice(-1)[0]?.trim() ?? "transport failure"}`,
			)
		}
		if (err instanceof RegistryHttpError) {
			die(BAKA_EXIT_CODE.FAILED, `registry at ${baseUrl} returned HTTP ${err.status}`)
		}
		throw err
	}
	if (!identity) {
		die(
			BAKA_EXIT_CODE.BAD_INPUT,
			`credential for ${baseUrl} was rejected by the registry (HTTP 401). Run \`baka registry login --token <key>\` to re-authenticate.`,
		)
	}
	console.log(`registry: ${baseUrl}`)
	console.log(`user:     ${identity.name ?? identity.email ?? identity.userId}`)
	if (identity.email) console.log(`email:    ${identity.email}`)
	console.log(`userId:   ${identity.userId}`)
	console.log(`key:      ${maskApiKey(credential.apiKey)}`)
}

// ---------------------------------------------------------------------------
// baka registry list (helper, not in the contract — useful for tests).
// ---------------------------------------------------------------------------

export function runRegistryList(): void {
	const all = readRegistryCredentials()
	const urls = Object.keys(all)
	if (urls.length === 0) {
		console.log("no registry credentials; use `baka registry login` to authenticate")
		return
	}
	console.log(`${urls.length} registry credential(s):`)
	for (const url of urls) {
		const cred = all[url]
		console.log(`  ${url}  key=${cred ? maskApiKey(cred.apiKey) : "(missing)"}`)
	}
}

// ---------------------------------------------------------------------------
// `baka registry auth status` is intentionally not exposed — the `list`
// subcommand prints the same masked information for every configured
// registry.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// baka registry info <spec> (architecture §8 decision 24, milestone 5
// cli-info-preview; VAL-DISC-030).
//
// Prints the served manifest, versions list, and screening verdict for
// a pack WITHOUT installing it. Field-for-field equal to the
// registry's two endpoints:
//   - `GET /v1/packs/<scope>/<name>` (scope, name, tier, visibility,
//     description, latestVersion, versions[])
//   - `GET /v1/packs/<scope>/<name>/<latestVersion>` (manifest + screening)
//
// `--json` emits the combined payload as a single JSON object. The
// payload is schema-parseable: a stable shape consumers can branch on
// without parsing free text. `--registry <url>` overrides the
// configured registry (same precedence as every other CLI registry
// command — see `resolveSingleRegistryUrl`).
//
// Auth (VAL-AUTH-003, decision 23): the CLI sends the stored
// per-registry credential when present. Public packs are reachable
// without a credential; org-visibility packs need membership. The
// CLI matches the registry's uniform 404 envelope for non-members —
// the existence-leak guard from the read surface carries through.
// ---------------------------------------------------------------------------

/**
 * Parsed shape of a `baka registry info <spec>` or
 * `baka registry preview <spec>` input. Mirrors the install spec
 * parser's registry shapes so the two surfaces agree on what
 * `@<scope>/<name>[@<version>]` means:
 *   - `name`                  — bare spec (resolves to the official
 *                              scope `baka`)
 *   - `@scope/name`           — scoped spec
 *   - `name@<version>`        — bare spec with a pinned version
 *   - `@scope/name@<version>` — scoped spec with a pinned version
 *
 * The `info` command accepts the same shapes; the `preview` command
 * additionally requires an explicit `@<version>` (a preview is
 * per-version, so the bare-pack case is rejected with a usage
 * error).
 */
interface InfoSpec {
	scope: string
	name: string
	pinnedVersion: string | null
}

function parseRegistryInfoSpec(spec: string): InfoSpec {
	const trimmed = spec.trim()
	if (trimmed.length === 0) {
		throw new Error("usage: baka registry info <spec> (e.g. @baka/hello or @acme/widget@1.0.0)")
	}
	let body = trimmed
	let pinnedVersion: string | null = null
	if (trimmed.includes("@")) {
		const lastAt = trimmed.lastIndexOf("@")
		if (lastAt > 0) {
			const candidate = trimmed.slice(lastAt + 1)
			// Accept `name@` (no version) and bare version numbers —
			// anything else is a malformed spec.
			if (candidate.length > 0 && /^[0-9]/.test(candidate)) {
				body = trimmed.slice(0, lastAt)
				pinnedVersion = candidate.replace(/^v/i, "")
			} else if (candidate.length === 0) {
				body = trimmed.slice(0, lastAt)
				pinnedVersion = null
			}
			// Trailing `@<something>` that is not a version is
			// intentionally accepted as part of the spec name
			// (mirrors the install parser — a `@` that does not
			// introduce a version is just part of the body).
		}
	}
	const isScoped = body.startsWith("@")
	const inner = isScoped ? body.slice(1) : body
	const slash = inner.indexOf("/")
	if (isScoped) {
		if (slash <= 0) {
			throw new Error(
				`registry spec '${trimmed}' is malformed; '@<scope>/<name>[@<version>]' requires both a scope and a name`,
			)
		}
		const scope = inner.slice(0, slash)
		const name = inner.slice(slash + 1)
		if (!/^[a-z0-9][a-z0-9._-]*$/i.test(scope) || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
			throw new Error(`registry spec '${trimmed}' has an invalid scope or pack name`)
		}
		return { scope, name, pinnedVersion }
	}
	// Bare name → official scope (architecture §8 decision 4).
	if (slash >= 0) {
		throw new Error(`registry spec '${trimmed}' is malformed; bare-name specs take no '/' (use '@<scope>/<name>')`)
	}
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(inner)) {
		throw new Error(`registry spec '${trimmed}' has an invalid pack name`)
	}
	return { scope: "baka", name: inner, pinnedVersion }
}

interface InfoOptions {
	registry?: string
	json?: boolean
	fetch?: typeof fetch
}

interface InfoPayload {
	scope: string
	name: string
	tier: string
	visibility: string
	description: string
	latestVersion: string | null
	versions: Array<{ version: string; status: string; createdAt: string }>
	manifest: Record<string, unknown> | null
	screening: { verdict: string } | null
}

/**
 * Fetches pack-detail + (latest) version-detail for `info`. The
 * two endpoints are called separately so the served payload is
 * byte-equal to the registry's two responses (the contract
 * compares the CLI's `--json` payload to the curl responses
 * field-for-field).
 */
async function fetchInfoPayload(opts: {
	baseUrl: string
	spec: InfoSpec
	apiKey?: string
	fetchImpl?: typeof fetch
}): Promise<{ payload: InfoPayload; resolvedVersion: string | null }> {
	const detail = await getPackDetail({
		baseUrl: opts.baseUrl,
		scope: opts.spec.scope,
		name: opts.spec.name,
		apiKey: opts.apiKey,
		fetchImpl: opts.fetchImpl,
	})
	if (detail === null) {
		throw new Error(`not found: pack '${opts.spec.scope}/${opts.spec.name}' is not served by this registry`)
	}
	const resolvedVersion = opts.spec.pinnedVersion ?? detail.latestVersion
	let manifest: Record<string, unknown> | null = null
	let screening: { verdict: string } | null = null
	if (resolvedVersion !== null) {
		const versionDetail = await getVersionDetail({
			baseUrl: opts.baseUrl,
			scope: opts.spec.scope,
			name: opts.spec.name,
			version: resolvedVersion,
			apiKey: opts.apiKey,
			fetchImpl: opts.fetchImpl,
		})
		if (versionDetail !== null) {
			manifest = versionDetail.manifest
			screening = versionDetail.screening !== null ? { verdict: versionDetail.screening.verdict } : null
		}
	}
	return {
		resolvedVersion,
		payload: {
			scope: detail.scope,
			name: detail.name,
			tier: detail.tier,
			visibility: detail.visibility,
			description: detail.description,
			latestVersion: detail.latestVersion,
			versions: detail.versions,
			manifest,
			screening,
		},
	}
}

/**
 * Renders the `info` payload as a human-readable block. Field
 * order matches the registry's two endpoints so the surface is
 * greppable; the `Recipes:` block iterates the manifest's recipes
 * with their params (the contract requires params + descriptions).
 */
function printInfoHuman(payload: InfoPayload, resolvedVersion: string | null): void {
	console.log(`pack:    @${payload.scope}/${payload.name}`)
	console.log(`tier:      ${payload.tier}`)
	console.log(`visibility:${payload.visibility}`)
	console.log(`description:`)
	console.log(`  ${payload.description || "(none)"}`)
	console.log(`latest version: ${payload.latestVersion ?? "<none>"}`)
	console.log(`versions:`)
	if (payload.versions.length === 0) {
		console.log(`  (no versions)`)
	} else {
		for (const v of payload.versions) {
			console.log(`  - ${v.version}  [${v.status}]  (created: ${v.createdAt})`)
		}
	}
	if (payload.screening !== null) {
		console.log(`screening verdict: ${payload.screening.verdict}`)
	} else if (resolvedVersion !== null) {
		console.log(`screening verdict: (not screened)`)
	}
	if (payload.manifest !== null) {
		const recipes = Array.isArray(payload.manifest.recipes)
			? (payload.manifest.recipes as Array<Record<string, unknown>>)
			: []
		console.log(`recipes:`)
		for (const recipe of recipes) {
			const id = typeof recipe.id === "string" ? recipe.id : "?"
			const description = typeof recipe.description === "string" ? recipe.description : ""
			const requiresReasoning = recipe.requiresReasoning === true
			console.log(`  - ${id}${requiresReasoning ? "  [requires-llm]" : ""}`)
			console.log(`      ${description}`)
			if (Array.isArray(recipe.params)) {
				for (const param of recipe.params as Array<Record<string, unknown>>) {
					const pname = typeof param.name === "string" ? param.name : "?"
					const ptype = typeof param.type === "string" ? param.type : "?"
					const pdesc = typeof param.description === "string" ? param.description : ""
					const required = param.required === true ? " (required)" : ""
					console.log(`      @param ${pname}: ${ptype}${required}  ${pdesc}`)
				}
			}
		}
	}
}

export async function runRegistryInfo(spec: string, opts: InfoOptions = {}): Promise<void> {
	let parsed: InfoSpec
	try {
		parsed = parseRegistryInfoSpec(spec)
	} catch (err) {
		die(BAKA_EXIT_CODE.BAD_INPUT, err instanceof Error ? err.message : String(err))
	}
	const baseUrl = resolveSingleRegistryUrl(opts.registry)
	const apiKey = readRegistryCredential(baseUrl)?.apiKey
	let payload: InfoPayload
	let resolvedVersion: string | null
	try {
		const result = await fetchInfoPayload({
			baseUrl,
			spec: parsed,
			apiKey,
			fetchImpl: opts.fetch,
		})
		payload = result.payload
		resolvedVersion = result.resolvedVersion
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("not found:")) {
			die(BAKA_EXIT_CODE.BAD_INPUT, err.message)
		}
		if (err instanceof RegistryTransportError) {
			die(
				BAKA_EXIT_CODE.FAILED,
				`registry at ${baseUrl} is unreachable: ${err.message.split(":").slice(-1)[0]?.trim() ?? "transport failure"}`,
			)
		}
		if (err instanceof RegistryHttpError) {
			die(BAKA_EXIT_CODE.FAILED, `registry at ${baseUrl} returned HTTP ${err.status}`)
		}
		throw err
	}
	if (opts.json) {
		console.log(JSON.stringify(payload, null, 2))
		return
	}
	printInfoHuman(payload, resolvedVersion)
}

// ---------------------------------------------------------------------------
// baka registry preview <spec> [--recipe <id>] (architecture §8 decision 24,
// milestone 5 cli-info-preview; VAL-DISC-031).
//
// Prints the served preview content per recipe WITHOUT installing
// the pack. Three states surface honestly:
//   - `rendered`   — non-reasoning recipe; the bytes the recipe wrote
//                    during dry-run are printed byte-equal to what
//                    `GET .../previews/<recipeId>` serves
//                    (VAL-CROSS-020 determinism invariant).
//   - `needs-llm`  — `requiresReasoning: true` recipe; an explicit
//                    `needs-llm` marker is printed and NO fabricated
//                    code is shown (the contract pins "no fabricated
//                    code for `requiresReasoning` recipes").
//   - empty list   — no preview records on the version (built-in
//                    packs bypass screening per decision 31; org-
//                    visibility packs skip screening per decision
//                    30); an explicit `no preview available` line
//                    is printed, not an empty screen.
//
// `--recipe <id>` filters to a single recipe's preview; the CLI
// fetches the per-recipe detail endpoint for the full file
// contents. `--registry <url>` overrides the configured registry.
//
// The recipe list is fetched from the version-detail `manifest`
// so the user sees ALL declared recipes even when no preview
// records exist for some of them (the `no preview available`
// line is followed by the recipe ids the user could install +
// see previews for).
// ---------------------------------------------------------------------------

interface PreviewOptions {
	registry?: string
	json?: boolean
	recipe?: string
	fetch?: typeof fetch
}

interface ManifestRecipe {
	id: string
	description?: string
	requiresReasoning?: boolean
}

interface PreviewPayload {
	scope: string
	name: string
	version: string
	previews: Array<
		| { recipeId: string; state: "rendered"; files: Array<{ path: string; content: string; sha256: string }> }
		| {
				recipeId: string
				state: "needs-llm"
				reason: string
				files: Array<{ path: string; content: string; sha256: string }>
		  }
	>
}

async function fetchPreviewRecipe(opts: {
	baseUrl: string
	scope: string
	name: string
	version: string
	recipeId: string
	apiKey?: string
	fetchImpl?: typeof fetch
}): Promise<{
	recipeId: string
	state: "rendered" | "needs-llm"
	reason?: string
	files: Array<{ path: string; content: string; sha256: string }>
} | null> {
	const detail = await getRecipePreview({
		baseUrl: opts.baseUrl,
		scope: opts.scope,
		name: opts.name,
		version: opts.version,
		recipeId: opts.recipeId,
		apiKey: opts.apiKey,
		fetchImpl: opts.fetchImpl,
	})
	if (detail === null) return null
	return {
		recipeId: detail.recipeId,
		state: detail.state,
		reason: detail.reason,
		files: detail.files ?? [],
	}
}

function printPreviewHumanSingle(payload: PreviewPayload, entry: PreviewPayload["previews"][number]): void {
	console.log(`@${payload.scope}/${payload.name}@${payload.version}  recipe: ${entry.recipeId}`)
	if (entry.state === "rendered") {
		console.log(`  state: rendered`)
		for (const file of entry.files) {
			console.log(`  --- ${file.path}  (sha256=${file.sha256}) ---`)
			console.log(file.content)
		}
	} else {
		console.log(`  state: needs-llm`)
		if (entry.reason) console.log(`  reason: ${entry.reason}`)
		console.log(`  (requires LLM at apply time; no rendered code is shown)`)
		for (const file of entry.files) {
			console.log(`  --- ${file.path}  (sentinel render, sha256=${file.sha256}) ---`)
			console.log(file.content)
		}
	}
}

function printPreviewHumanAll(opts: {
	payload: PreviewPayload
	previews: Array<{
		recipeId: string
		state: "rendered" | "needs-llm"
		files?: Array<{ path: string; size: number; sha256: string }>
	}>
	manifestRecipes: ManifestRecipe[]
}): void {
	console.log(`@${opts.payload.scope}/${opts.payload.name}@${opts.payload.version}`)
	if (opts.previews.length === 0) {
		console.log(`  no preview available`)
		if (opts.manifestRecipes.length > 0) {
			console.log(`  recipes declared in manifest:`)
			for (const a of opts.manifestRecipes) {
				const tag = a.requiresReasoning ? "  [needs-llm]" : ""
				console.log(`    - ${a.id}${tag}`)
			}
		}
		return
	}
	console.log(`  ${opts.previews.length} recipe previews:`)
	for (const p of opts.previews) {
		if (p.state === "rendered") {
			console.log(`  - ${p.recipeId}  state: rendered`)
			if (p.files && p.files.length > 0) {
				for (const file of p.files) {
					console.log(`      ${file.path}  (sha256=${file.sha256}, size=${file.size})`)
				}
			}
		} else {
			console.log(`  - ${p.recipeId}  state: needs-llm`)
			console.log(`      (requires LLM at apply time; no rendered code is shown)`)
		}
	}
}

export async function runRegistryPreview(spec: string, opts: PreviewOptions = {}): Promise<void> {
	let parsed: InfoSpec
	try {
		parsed = parseRegistryInfoSpec(spec)
	} catch (err) {
		die(BAKA_EXIT_CODE.BAD_INPUT, err instanceof Error ? err.message : String(err))
	}
	const baseUrl = resolveSingleRegistryUrl(opts.registry)
	const apiKey = readRegistryCredential(baseUrl)?.apiKey

	// When no version is pinned, resolve to the latest version
	// via the pack-detail endpoint (semver max of ready
	// versions per architecture §4.5 + decision 11). The
	// `[@<version>]` shape in decision 24 is OPTIONAL.
	let resolvedVersion = parsed.pinnedVersion
	let manifestRecipes: ManifestRecipe[] = []
	let previews: Array<{
		recipeId: string
		state: "rendered" | "needs-llm"
		files?: Array<{ path: string; size: number; sha256: string }>
	}> = []
	try {
		if (resolvedVersion === null) {
			const detail = await getPackDetail({
				baseUrl,
				scope: parsed.scope,
				name: parsed.name,
				apiKey,
				fetchImpl: opts.fetch,
			})
			if (detail === null) {
				die(BAKA_EXIT_CODE.BAD_INPUT, `not found: pack '${parsed.scope}/${parsed.name}' is not served by this registry`)
			}
			if (detail.latestVersion === null) {
				die(
					BAKA_EXIT_CODE.BAD_INPUT,
					`no installable version for '${parsed.scope}/${parsed.name}' (every version is non-ready)`,
				)
			}
			resolvedVersion = detail.latestVersion
		}
		const versionDetail = await getVersionDetail({
			baseUrl,
			scope: parsed.scope,
			name: parsed.name,
			version: resolvedVersion,
			apiKey,
			fetchImpl: opts.fetch,
		})
		if (versionDetail === null) {
			die(
				BAKA_EXIT_CODE.BAD_INPUT,
				`not found: version '${parsed.scope}/${parsed.name}@${resolvedVersion}' is not served by this registry`,
			)
		}
		const rawRecipes = Array.isArray(versionDetail.manifest.recipes)
			? (versionDetail.manifest.recipes as Array<Record<string, unknown>>)
			: []
		manifestRecipes = rawRecipes
			.filter((a): a is { id: string; description?: string; requiresReasoning?: boolean } => typeof a.id === "string")
			.map((a) => ({
				id: a.id,
				...(typeof a.description === "string" ? { description: a.description } : {}),
				...(a.requiresReasoning === true ? { requiresReasoning: true } : {}),
			}))

		if (opts.recipe !== undefined && opts.recipe.length > 0) {
			const detail = await fetchPreviewRecipe({
				baseUrl,
				scope: parsed.scope,
				name: parsed.name,
				version: resolvedVersion,
				recipeId: opts.recipe,
				apiKey,
				fetchImpl: opts.fetch,
			})
			if (detail === null) {
				die(
					BAKA_EXIT_CODE.BAD_INPUT,
					`no preview record for recipe '${opts.recipe}' on ${parsed.scope}/${parsed.name}@${resolvedVersion}`,
				)
			}
			const payload: PreviewPayload = {
				scope: parsed.scope,
				name: parsed.name,
				version: resolvedVersion,
				previews: [
					detail.state === "rendered"
						? {
								recipeId: detail.recipeId,
								state: "rendered",
								files: detail.files,
							}
						: {
								recipeId: detail.recipeId,
								state: "needs-llm",
								reason: detail.reason ?? "recipe skipped because it requires LLM reasoning",
								files: detail.files,
							},
				],
			}
			if (opts.json) {
				console.log(JSON.stringify(payload, null, 2))
				return
			}
			const first = payload.previews[0]
			if (first !== undefined) printPreviewHumanSingle(payload, first)
			return
		}

		previews = await getPackPreviews({
			baseUrl,
			scope: parsed.scope,
			name: parsed.name,
			version: resolvedVersion,
			apiKey,
			fetchImpl: opts.fetch,
		})
	} catch (err) {
		if (err instanceof RegistryTransportError) {
			die(
				BAKA_EXIT_CODE.FAILED,
				`registry at ${baseUrl} is unreachable: ${err.message.split(":").slice(-1)[0]?.trim() ?? "transport failure"}`,
			)
		}
		if (err instanceof RegistryHttpError) {
			die(BAKA_EXIT_CODE.FAILED, `registry at ${baseUrl} returned HTTP ${err.status}`)
		}
		throw err
	}

	if (opts.json) {
		const payload: PreviewPayload = {
			scope: parsed.scope,
			name: parsed.name,
			version: resolvedVersion,
			previews: [],
		}
		for (const p of previews) {
			if (p.state === "rendered") {
				const detail = await fetchPreviewRecipe({
					baseUrl,
					scope: parsed.scope,
					name: parsed.name,
					version: resolvedVersion,
					recipeId: p.recipeId,
					apiKey,
					fetchImpl: opts.fetch,
				})
				if (detail !== null) {
					payload.previews.push({
						recipeId: p.recipeId,
						state: "rendered",
						files: detail.files,
					})
				}
			} else {
				payload.previews.push({
					recipeId: p.recipeId,
					state: "needs-llm",
					reason: "recipe skipped because it requires LLM reasoning",
					files: [],
				})
			}
		}
		console.log(JSON.stringify(payload, null, 2))
		return
	}

	const payload: PreviewPayload = {
		scope: parsed.scope,
		name: parsed.name,
		version: resolvedVersion,
		previews: [],
	}
	printPreviewHumanAll({ payload, previews, manifestRecipes })
}
