import {
	getConfigValue,
	listConfigKeys,
	secretsPath,
	setConfigValue,
	unsetConfigValue,
	userConfigPath,
} from "@repo/agent-engine"
import { BAKA_EXIT_CODE } from "@repo/protocol"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

function isSensitiveKey(key: string): boolean {
	const lower = key.toLowerCase()
	return lower.includes("key") || lower.includes("secret") || lower.includes("token") || lower.includes("password")
}

function maskIfSensitive(key: string, value: unknown): string {
	if (isSensitiveKey(key)) return "<redacted>"
	if (value === null || value === undefined) return String(value)
	if (typeof value === "string") return value
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

export function runConfigList(): void {
	const keys = listConfigKeys()
	if (keys.length === 0) {
		console.log("(no config keys set; run `baka init` to configure)")
		return
	}
	for (const key of keys.sort()) {
		const value = getConfigValue(key)
		console.log(`${key} = ${maskIfSensitive(key, value)}`)
	}
}

export function runConfigGet(key: string): void {
	if (!key) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka config get <key>")
	const value = getConfigValue(key)
	if (value === undefined) {
		console.log("(unset)")
		return
	}
	if (isSensitiveKey(key)) {
		die(
			BAKA_EXIT_CODE.USER_ERROR,
			"sensitive values are not retrievable. Use `baka config set <key> <value>` to update, or edit the credentials file directly.",
		)
	}
	console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2))
}

export function runConfigSet(key: string, value: string): void {
	if (!key || value === undefined) {
		die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka config set <key> <value>")
	}
	if (isSensitiveKey(key)) {
		die(
			BAKA_EXIT_CODE.USER_ERROR,
			`"${key}" looks sensitive. Sensitive values go in the credentials file, not the user config. Use \`baka providers add\` to set an API key.`,
		)
	}

	let parsed: unknown = value
	try {
		parsed = JSON.parse(value)
	} catch {
		/* keep as string */
	}
	setConfigValue(key, parsed as never)
	console.log(`set ${key}`)
}

export function runConfigUnset(key: string): void {
	if (!key) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka config unset <key>")
	unsetConfigValue(key)
	console.log(`unset ${key}`)
}

export function runConfigPath(): void {
	console.log(`user config: ${userConfigPath()}`)
	console.log(`credentials: ${secretsPath()}`)
}
