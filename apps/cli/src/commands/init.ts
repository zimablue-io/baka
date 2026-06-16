import { input, password, select, confirm } from "@inquirer/prompts"
import {
	getApiKey,
	getProvider,
	listProviders,
	secretsPath,
	setActiveProviderName,
	setApiKey,
	setProvider,
	userConfigPath,
} from "@repo/agent-engine"
import { BAKA_EXIT_CODE } from "@repo/protocol"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

const DEFAULT_BASE_URL = "http://localhost:8080"
const DEFAULT_MODEL = "gemma4:e4b-it"

export async function runInit(): Promise<void> {
	const existing = listProviders()
	const activeName = existing.find((p) => p.active)?.name
	if (existing.length > 0) {
		const overwrite = await confirm({
			message: `Found ${existing.length} configured provider(s)${activeName ? ` (active: ${activeName})` : ""}. Add a new one?`,
			default: true,
		})
		if (!overwrite) {
			console.log("init: no changes made.")
			return
		}
	}

	const name = await input({
		message: "Provider name (used by --provider=<name>):",
		default: existing.length === 0 ? "local" : "",
		validate: (v) =>
			(v.trim() === "" ? "required" : /^[a-z0-9_-]+$/i.test(v) || "letters, digits, _ and - only") || true,
	})
	if (!name.trim()) die(BAKA_EXIT_CODE.USER_ERROR, "provider name is required")

	if (getProvider(name)) {
		die(
			BAKA_EXIT_CODE.USER_ERROR,
			`provider "${name}" already exists. Use \`baka providers use ${name}\` to switch to it.`,
		)
	}

	const baseUrl = await input({
		message: "OpenAI-compatible base URL:",
		default: DEFAULT_BASE_URL,
		validate: (v) => (v.trim() === "" ? "required" : true),
	})

	const model = await input({
		message: "Model id:",
		default: DEFAULT_MODEL,
		validate: (v) => (v.trim() === "" ? "required" : true),
	})

	const apiKey = await password({
		message: `API key (leave blank to store "none" for local servers; stored separately at ${secretsPath()} with 0600 perms):`,
		mask: "*",
	})

	const temperatureStr = await input({
		message: "Default temperature (0.0 = deterministic):",
		default: "0.0",
		validate: (v) => (!Number.isNaN(Number(v)) ? true : "must be a number"),
	})
	const maxTokensStr = await input({
		message: "Default max tokens:",
		default: "8192",
		validate: (v) => (!Number.isNaN(Number(v)) ? true : "must be a number"),
	})
	const timeoutStr = await input({
		message: "Default timeout (ms):",
		default: "120000",
		validate: (v) => (!Number.isNaN(Number(v)) ? true : "must be a number"),
	})

	const setActive = await confirm({
		message: `Set "${name}" as the active provider?`,
		default: true,
	})

	setProvider(name, {
		baseUrl,
		model,
		temperature: Number(temperatureStr),
		maxTokens: Number(maxTokensStr),
		timeoutMs: Number(timeoutStr),
	})

	await setApiKey(name, apiKey === "" ? "none" : apiKey)

	if (setActive) setActiveProviderName(name)

	console.log("")
	console.log(`  baka: provider "${name}" saved`)
	console.log(`    user config: ${userConfigPath()}`)
	console.log(`    credentials: ${secretsPath()}`)
	console.log(`    use it:      baka --provider=${name} plan "..."`)
	console.log("")
}
