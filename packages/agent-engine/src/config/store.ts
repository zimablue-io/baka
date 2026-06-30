import { chmodSync, existsSync, promises as fs, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, join } from "node:path"
import { BAKA_USER_DIR } from "@repo/protocol"

// ---------------------------------------------------------------------------
// User config (non-secret). Stored at ~/.baka/config.json.
// Project-level overrides at <cwd>/.baka/config.json are handled by
// loadLLMConfig in index.ts, not here.
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

const DEFAULT_CONFIG: UserConfigShape = {
	providers: {},
	defaults: { temperature: 0.0, maxTokens: 8192, timeoutMs: 120_000 },
}

function configFilePath(): string {
	return join(homedir(), `.${BAKA_USER_DIR}`, "config.json")
}

function readConfigFile(): UserConfigShape {
	const path = configFilePath()
	if (!existsSync(path)) return { ...DEFAULT_CONFIG }
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as UserConfigShape
		return { ...DEFAULT_CONFIG, ...raw }
	} catch {
		return { ...DEFAULT_CONFIG }
	}
}

function writeConfigFile(cfg: UserConfigShape): void {
	const path = configFilePath()
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify(cfg, null, 2), "utf-8")
}

/** Get a value by dot-notation key (e.g. "providers.llama_cpp.baseUrl"). */
function getByPath(obj: unknown, key: string): unknown {
	const parts = key.split(".")
	let cur: unknown = obj
	for (const p of parts) {
		if (cur === null || typeof cur !== "object") return undefined
		cur = (cur as Record<string, unknown>)[p]
	}
	return cur
}

/** Set a value by dot-notation key, creating intermediate objects as needed. */
function setByPath(obj: Record<string, unknown>, key: string, value: unknown): void {
	const parts = key.split(".")
	let cur: Record<string, unknown> = obj
	for (let i = 0; i < parts.length - 1; i++) {
		const p = parts[i]
		if (cur[p] === null || typeof cur[p] !== "object") cur[p] = {}
		cur = cur[p] as Record<string, unknown>
	}
	cur[parts[parts.length - 1]] = value
}

/** Delete a value by dot-notation key. */
function deleteByPath(obj: Record<string, unknown>, key: string): void {
	const parts = key.split(".")
	let cur: Record<string, unknown> = obj
	for (let i = 0; i < parts.length - 1; i++) {
		const p = parts[i]
		if (cur[p] === null || typeof cur[p] !== "object") return
		cur = cur[p] as Record<string, unknown>
	}
	delete cur[parts[parts.length - 1]]
}

// ---------------------------------------------------------------------------
// Credentials (secrets). Stored separately at ~/.baka/credentials with 0600.
// ---------------------------------------------------------------------------

function credentialsPath(): string {
	return join(homedir(), `.${BAKA_USER_DIR}`, "credentials")
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
	const cfg = readConfigFile()
	const active = cfg.activeProvider
	const providers = cfg.providers ?? {}
	return Object.entries(providers).map(([name, provider]) => ({
		name,
		provider: provider as BakaUserProvider,
		active: name === active,
	}))
}

export function getProvider(name: string): BakaUserProvider | undefined {
	const cfg = readConfigFile()
	return cfg.providers?.[name] as BakaUserProvider | undefined
}

export function setProvider(name: string, provider: BakaUserProvider): void {
	const cfg = readConfigFile()
	cfg.providers[name] = provider
	writeConfigFile(cfg)
}

export function deleteProvider(name: string): void {
	const cfg = readConfigFile()
	delete cfg.providers[name]
	if (cfg.activeProvider === name) cfg.activeProvider = undefined
	writeConfigFile(cfg)
}

export function getActiveProviderName(): string | undefined {
	return readConfigFile().activeProvider
}

export function setActiveProviderName(name: string | undefined): void {
	const cfg = readConfigFile()
	cfg.activeProvider = name
	writeConfigFile(cfg)
}

export function getConfigPath(): string {
	return configFilePath()
}

export function getConfigValue(key: string): unknown {
	return getByPath(readConfigFile(), key)
}

export function setConfigValue(key: string, value: unknown): void {
	const cfg = readConfigFile()
	setByPath(cfg as unknown as Record<string, unknown>, key, value)
	writeConfigFile(cfg)
}

export function unsetConfigValue(key: string): void {
	const cfg = readConfigFile()
	deleteByPath(cfg as unknown as Record<string, unknown>, key)
	writeConfigFile(cfg)
}

export function listConfigKeys(): string[] {
	return Object.keys(readConfigFile())
}

export function userConfigPath(): string {
	return configFilePath()
}

export function secretsPath(): string {
	return credentialsPath()
}

/** @lintignore Public platform-detection helper; consumed by downstream packages that need cross-platform paths. */
export const CURRENT_PLATFORM = platform()
/** @lintignore Public platform-detection helper; consumed by downstream packages that need cross-platform paths. */
export const IS_WINDOWS = platform() === "win32"
