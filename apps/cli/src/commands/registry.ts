import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { BAKA_EXIT_CODE, normalizeRegistryUrl } from "@repo/protocol"
import {
	DEFAULT_REGISTRY_URL,
	maskApiKey,
	RegistryHttpError,
	RegistryTransportError,
	whoami,
} from "../lib/registry-client"
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

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

function resolveRegistryUrl(flagValue: string | undefined): string {
	const raw = flagValue && flagValue.length > 0 ? flagValue : DEFAULT_REGISTRY_URL
	// Normalize on the read path too: a trailing slash or a mixed-case
	// scheme/host must not change the URL we send to the registry,
	// otherwise `…http://host:4310/` becomes `…http://host:4310//api/…`
	// (double slash) which some servers refuse.
	return normalizeRegistryUrl(raw)
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
				BAKA_EXIT_CODE.ENGINE_ERROR,
				`cannot verify key: registry unreachable at ${baseUrl} (${err.message.split(":").slice(-1)[0]?.trim() ?? "transport failure"})`,
			)
		}
		if (err instanceof RegistryHttpError) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, `cannot verify key: registry returned HTTP ${err.status}`)
		}
		throw err
	}
	if (!identity) {
		die(
			BAKA_EXIT_CODE.USER_ERROR,
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
			BAKA_EXIT_CODE.USER_ERROR,
			`login not completed: timed out waiting for the registry to redirect back to ${callbackUrl}. Run \`baka registry login --token <key>\` to paste a key directly.`,
		)
	}
	stopCallbackServer()
	if (received.state !== state) {
		die(
			BAKA_EXIT_CODE.USER_ERROR,
			`login not completed: state mismatch (expected ${state}, got ${received.state ?? "<missing>"}). Run \`baka registry login --token <key>\` to paste a key directly.`,
		)
	}
	if (!received.apiKey) {
		die(
			BAKA_EXIT_CODE.USER_ERROR,
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
		die(BAKA_EXIT_CODE.USER_ERROR, `no credential stored for ${baseUrl}. Run \`baka registry login\` to authenticate.`)
	}
	let identity: Awaited<ReturnType<typeof whoami>>
	try {
		identity = await whoami({ baseUrl, apiKey: credential.apiKey })
	} catch (err) {
		if (err instanceof RegistryTransportError) {
			die(
				BAKA_EXIT_CODE.ENGINE_ERROR,
				`registry at ${baseUrl} is unreachable: ${err.message.split(":").slice(-1)[0]?.trim() ?? "transport failure"}`,
			)
		}
		if (err instanceof RegistryHttpError) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, `registry at ${baseUrl} returned HTTP ${err.status}`)
		}
		throw err
	}
	if (!identity) {
		die(
			BAKA_EXIT_CODE.USER_ERROR,
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
