import { input, select, confirm } from "@inquirer/prompts"
import { BAKA_EXIT_CODE } from "@repo/protocol"
import {
	deleteProvider,
	getActiveProviderName,
	getApiKey,
	getProvider,
	listProviders,
	setActiveProviderName,
	setApiKey,
	setProvider,
} from "@repo/agent-engine"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

const DEFAULT_BASE_URL = "http://localhost:8080"
const DEFAULT_MODEL = "gemma4:e4b-it"

export async function runProvidersAdd(): Promise<void> {
	const name = await input({
		message: "Provider name:",
		validate: (v) => (v.trim() === "" ? "required" : /^[a-z0-9_-]+$/i.test(v) || "letters, digits, _ and - only") || true,
	})
	if (getProvider(name)) {
		die(BAKA_EXIT_CODE.USER_ERROR, `provider "${name}" already exists`)
	}

	const baseUrl = await input({ message: "OpenAI-compatible base URL:", default: DEFAULT_BASE_URL })
	const model = await input({ message: "Model id:", default: DEFAULT_MODEL })
	const temperatureStr = await input({
		message: "Temperature (0.0 - 2.0; 0.0 for deterministic plans):",
		default: "0.0",
		validate: (v) => {
			const n = Number(v)
			return (!Number.isNaN(n) && n >= 0 && n <= 2) || "must be a number between 0 and 2"
		},
	})
	const maxTokensStr = await input({
		message: "Max tokens per response:",
		default: "8192",
		validate: (v) => {
			const n = Number(v)
			return Number.isInteger(n) && n > 0 || "must be a positive integer"
		},
	})
	const timeoutStr = await input({
		message: "Request timeout (ms):",
		default: "120000",
		validate: (v) => {
			const n = Number(v)
			return Number.isInteger(n) && n > 0 || "must be a positive integer"
		},
	})
	const { password } = await import("@inquirer/prompts")
	const apiKey = await password({ message: "API key (blank for local servers):", mask: "*" })
	const setActive = await confirm({ message: `Set "${name}" as active?`, default: true })

	setProvider(name, {
		baseUrl,
		model,
		temperature: Number(temperatureStr),
		maxTokens: Number(maxTokensStr),
		timeoutMs: Number(timeoutStr),
	})
	await setApiKey(name, apiKey === "" ? "none" : apiKey)
	if (setActive) setActiveProviderName(name)

	console.log(`added provider "${name}"`)
}

export function runProvidersList(): void {
	const providers = listProviders()
	if (providers.length === 0) {
		console.log("(no providers configured; run `baka providers add` or `baka init`)")
		return
	}
	const active = getActiveProviderName()
	for (const { name, provider, active: isActive } of providers) {
		const marker = isActive ? "*" : " "
		console.log(`${marker} ${name}`)
		console.log(`    baseUrl:   ${provider.baseUrl}`)
		console.log(`    model:     ${provider.model}`)
		if (provider.temperature !== undefined) console.log(`    temp:      ${provider.temperature}`)
		if (provider.maxTokens !== undefined) console.log(`    maxTokens: ${provider.maxTokens}`)
		if (provider.timeoutMs !== undefined) console.log(`    timeoutMs: ${provider.timeoutMs}`)
	}
	if (active) console.log(`(active provider marked with *)`)
}

export async function runProvidersUse(name: string): Promise<void> {
	if (!name) {
		// Interactive: pick from list
		const providers = listProviders()
		if (providers.length === 0) {
			die(BAKA_EXIT_CODE.USER_ERROR, "no providers configured; run `baka providers add` first")
		}
		const picked = await select({
			message: "Switch to which provider?",
			choices: providers.map((p) => ({ name: p.name, value: p.name })),
		})
		name = picked
	}
	if (!getProvider(name)) {
		die(BAKA_EXIT_CODE.USER_ERROR, `provider "${name}" not found. Run \`baka providers list\`.`)
	}
	if (!(await getApiKey(name))) {
		console.warn(`baka: warning: provider "${name}" has no API key set. Run \`baka providers add ${name}\` to set one.`)
	}
	setActiveProviderName(name)
	console.log(`active provider is now "${name}"`)
}

export async function runProvidersRemove(name: string): Promise<void> {
	if (!name) {
		const providers = listProviders()
		if (providers.length === 0) {
			die(BAKA_EXIT_CODE.USER_ERROR, "no providers to remove")
		}
		name = await select({
			message: "Remove which provider?",
			choices: providers.map((p) => ({ name: p.name, value: p.name })),
		})
	}
	if (!getProvider(name)) {
		die(BAKA_EXIT_CODE.USER_ERROR, `provider "${name}" not found`)
	}
	const confirmRemove = await confirm({ message: `Remove provider "${name}"?`, default: false })
	if (!confirmRemove) return
	deleteProvider(name)
	console.log(`removed provider "${name}"`)
}
