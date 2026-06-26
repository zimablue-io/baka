import { chmodSync, existsSync, promises as fs } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, join } from "node:path"
import { BAKA_USER_DIR } from "@repo/protocol"
import Conf from "conf"

// ---------------------------------------------------------------------------
// User config (non-secret). XDG-aware via the `conf` library.
// ---------------------------------------------------------------------------

type UserConfigShape = {
	providers: Record<string, BakaUserProvider>
	activeProvider?: string
	defaults: {
		temperature: number
		maxTokens: number
		timeoutMs: number
	}
}

export interface BakaUserProvider {
	baseUrl: string
	apiKeyRef?: string
	model: string
	temperature?: number
	maxTokens?: number
	timeoutMs?: number
	providerOptions?: Record<string, unknown>
}

let _store: Conf<UserConfigShape> | null = null

function userStore(): Conf<UserConfigShape> {
	if (_store) return _store
	_store = new Conf<UserConfigShape>({
		projectName: BAKA_USER_DIR,
		cwd: homedir(),
		defaults: {
			providers: {},
			defaults: { temperature: 0.0, maxTokens: 8192, timeoutMs: 120_000 },
		},
	})
	return _store
}

// ---------------------------------------------------------------------------
// Credentials (secrets). Stored separately with 0600 perms.
// ---------------------------------------------------------------------------

function credentialsPath(): string {
	return join(homedir(), ".config", BAKA_USER_DIR, "credentials")
}

interface CredentialBlob {
	providers: Record<string, { apiKey: string }>
}

async function readCredentials(): Promise<CredentialBlob> {
	const path = credentialsPath()
	if (!existsSync(path)) return { providers: {} }
	const raw = await fs.readFile(path, "utf-8")
	try {
		return JSON.parse(raw) as CredentialBlob
	} catch {
		throw new Error(`baka: credentials file at ${path} is corrupt; delete it and run \`baka init\` again.`)
	}
}

async function writeCredentials(blob: CredentialBlob): Promise<void> {
	const path = credentialsPath()
	await fs.mkdir(dirname(path), { recursive: true })
	await fs.writeFile(path, JSON.stringify(blob, null, 2), { encoding: "utf-8", mode: 0o600 })
	try {
		chmodSync(path, 0o600)
	} catch {
		/* best effort */
	}
}

export async function getApiKey(providerName: string): Promise<string | undefined> {
	const blob = await readCredentials()
	return blob.providers[providerName]?.apiKey
}

export async function setApiKey(providerName: string, apiKey: string): Promise<void> {
	const blob = await readCredentials()
	blob.providers[providerName] = { apiKey }
	await writeCredentials(blob)
}

export async function unsetApiKey(providerName: string): Promise<void> {
	const blob = await readCredentials()
	delete blob.providers[providerName]
	await writeCredentials(blob)
}

// ---------------------------------------------------------------------------
// User-config CRUD
// ---------------------------------------------------------------------------

export function listProviders(): Array<{ name: string; provider: BakaUserProvider; active: boolean }> {
	const cfg = userStore()
	const active = cfg.get("activeProvider")
	const providers = (cfg.get("providers") ?? {}) as Record<string, BakaUserProvider>
	return Object.entries(providers).map(([name, provider]) => ({
		name,
		provider: provider as BakaUserProvider,
		active: name === active,
	}))
}

export function getProvider(name: string): BakaUserProvider | undefined {
	return userStore().get(`providers.${name}`) as BakaUserProvider | undefined
}

export function setProvider(name: string, provider: BakaUserProvider): void {
	userStore().set(`providers.${name}`, provider)
}

export function deleteProvider(name: string): void {
	const cfg = userStore()
	cfg.delete(`providers.${name}`)
	if (cfg.get("activeProvider") === name) cfg.delete("activeProvider")
}

export function getActiveProviderName(): string | undefined {
	return userStore().get("activeProvider")
}

export function setActiveProviderName(name: string | undefined): void {
	if (name === undefined) {
		userStore().delete("activeProvider")
	} else {
		userStore().set("activeProvider", name)
	}
}

export function getConfigPath(): string {
	return userStore().path
}

export function getConfigValue(key: string): unknown {
	return userStore().get(key as keyof UserConfigShape)
}

export function setConfigValue(key: string, value: unknown): void {
	userStore().set(key as keyof UserConfigShape, value as never)
}

export function unsetConfigValue(key: string): void {
	userStore().delete(key as keyof UserConfigShape)
}

export function listConfigKeys(): string[] {
	return Object.keys(userStore().store)
}

export function userConfigPath(): string {
	return userStore().path
}

export function secretsPath(): string {
	return credentialsPath()
}

/** @lintignore Public platform-detection helper; consumed by downstream packages that need cross-platform paths. */
export const CURRENT_PLATFORM = platform()
/** @lintignore Public platform-detection helper; consumed by downstream packages that need cross-platform paths. */
export const IS_WINDOWS = platform() === "win32"
