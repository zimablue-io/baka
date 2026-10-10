// ---------------------------------------------------------------------------
// Entry point for the `baka pack create <name>` and `baka pack
// consistency <name>` commands. Wires the workflow SDK (chat loop, state
// machine, slash commands) to the CLI's I/O (inquirer, console, file
// system). The LLM provider is injected for testability: in production
// it's created from the user's config; in tests it can be a fake.
// ---------------------------------------------------------------------------

import { join } from "node:path"
import { input as inquirerInput } from "@inquirer/prompts"
import { createLLMProvider, loadLLMConfig, validateLLMConfig } from "@repo/agent-engine"
import {
	type ChatLoopHooks,
	type ChatLoopResult,
	createInitialState,
	invalidPackNameMessage,
	isValidPackName,
	loadSession,
	runChatLoop,
	saveSession,
} from "@repo/pack-management-workflow"
import { BAKA_EXIT_CODE, type LLMProvider } from "@repo/protocol"
import { createPackSandbox, runConsistencyInSandbox } from "./consistency"
import { isE2EMode } from "./e2e-input"
import { promptDefineApproval, promptDeliverApproval, promptDevelopApproval, promptUser } from "./prompts"
import { renderBriefEcho, renderConsistencyResult, renderPayload, renderResumeContext } from "./render"

const STATE_FILE = ".design-state.json"

interface RunPackDesignDeps {
	loadLLMConfig: typeof loadLLMConfig
	createLLMProvider: typeof createLLMProvider
	input: typeof inquirerInput
	/** Override for tests; defaults to reading ~/.baka/config.json. */
	getProvider?: (cwd: string) => Promise<LLMProvider>
}

const defaultDeps: RunPackDesignDeps = {
	loadLLMConfig,
	createLLMProvider,
	input: inquirerInput,
}

export async function runPackDesign(
	name: string,
	opts: { cwd: string; resume?: boolean },
	deps: RunPackDesignDeps = defaultDeps,
): Promise<void> {
	if (!name) {
		die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka pack create <name>")
	}
	if (!isValidPackName(name)) {
		die(BAKA_EXIT_CODE.USER_ERROR, invalidPackNameMessage())
	}

	const packDir = join(opts.cwd, "packs", name)
	const statePath = join(packDir, STATE_FILE)
	const existing = loadSession(packDir)
	if (existing) {
		console.log(`\n[resuming design session for ${name} — phase: ${existing.phase}]\n`)
		console.log(renderResumeContext(existing))
	} else {
		const brief =
			isE2EMode() && process.env.BAKA_E2E_BRIEF
				? process.env.BAKA_E2E_BRIEF
				: await deps.input({
						message: `In one or two sentences, what should the pack "${name}" do?`,
						validate: (v) => (v.trim().length > 5 ? true : "give me a bit more"),
					})
		console.log(renderBriefEcho(brief))
		const fresh = createInitialState({ packName: name, brief })
		saveSession(fresh, packDir)
	}

	const config = await deps.loadLLMConfig({ role: "worker", cwd: opts.cwd })
	try {
		validateLLMConfig(config)
	} catch (err) {
		die(BAKA_EXIT_CODE.ENGINE_ERROR, `LLM config: ${err instanceof Error ? err.message : String(err)}`)
	}
	const provider = deps.getProvider ? await deps.getProvider(opts.cwd) : deps.createLLMProvider(config)

	const hooks: ChatLoopHooks = {
		onAssistantMessage: (payload, state) => {
			console.log(renderPayload(payload, state))
		},
		onUserInput: promptUser,
		onDefineApproval: promptDefineApproval,
		onDevelopApproval: promptDevelopApproval,
		onDeliverApproval: promptDeliverApproval,
		onBootstrapFailed: (err) => {
			console.error(`\n[bootstrap LLM call failed: ${err}]`)
			console.error(`[the LLM did not respond to the brief; type your answer anyway and the LLM will retry]\n`)
		},
		onStateChanged: (state) => saveSession(state, packDir),
		runConsistency: (n, intent) => runConsistencyInSandbox({ n, intent, packName: name, packDir, cwd: opts.cwd }),
	}

	const result: ChatLoopResult = await runChatLoop({
		provider,
		packDir,
		hooks,
		brief: existing?.brief ?? loadSession(packDir)?.brief,
	})

	if (result.exited === "done") {
		console.log(`\n[pack ${name} delivered; CONSISTENCY.md has the trace]\n`)
	} else if (result.exited === "consistency-failure") {
		console.log(`\n[consistency failed; pack ${name} left in DEVELOP for refinement]\n`)
		process.exit(BAKA_EXIT_CODE.VALIDATION_ERROR)
	} else if (result.exited === "rejected") {
		console.log(`\n[deliver cancelled by user; pack ${name} rolled back to DEVELOP]\n`)
	} else if (result.exited === "user-exit") {
		console.log(`\n[session saved to ${statePath}; resume with \`baka pack create ${name}\`]\n`)
	}
}

export async function runPackConsistency(
	name: string,
	opts: { cwd: string; recipeId?: string; intent?: string; n?: number },
): Promise<void> {
	const packDir = join(opts.cwd, "packs", name)
	const state = loadSession(packDir)
	const recipeId = opts.recipeId ?? state?.designedRecipes?.[0]?.id
	if (!recipeId) {
		die(BAKA_EXIT_CODE.USER_ERROR, `could not determine recipe id; pass --recipe=<id>`)
	}
	const intent =
		opts.intent ?? state?.designedRecipes?.find((a) => a.id === recipeId)?.testIntent ?? `use ${name}:${recipeId}`
	const n = opts.n ?? 5

	const sandbox = createPackSandbox({ packName: name, packDir, cwd: opts.cwd })
	try {
		const { runConsistencyTest } = await import("@repo/ast-tooling")
		const result = await runConsistencyTest({ cwd: sandbox.tempDir, packName: name, recipeId, intent, n })
		console.log(renderConsistencyResult(result))
		if (!result.passed) process.exit(BAKA_EXIT_CODE.VALIDATION_ERROR)
	} finally {
		sandbox.cleanup()
	}
}

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}
