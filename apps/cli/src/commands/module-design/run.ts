// ---------------------------------------------------------------------------
// Entry point for the `baka module create <name>` and `baka module
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
	invalidModuleNameMessage,
	isValidModuleName,
	loadSession,
	runChatLoop,
	saveSession,
} from "@repo/module-management-workflow"
import { BAKA_EXIT_CODE, type LLMProvider } from "@repo/protocol"
import { createModuleSandbox, runConsistencyInSandbox } from "./consistency"
import { isE2EMode } from "./e2e-input"
import { promptDefineApproval, promptDeliverApproval, promptDevelopApproval, promptUser } from "./prompts"
import { renderBriefEcho, renderConsistencyResult, renderPayload, renderResumeContext } from "./render"

const STATE_FILE = ".design-state.json"

export interface RunModuleDesignDeps {
	loadLLMConfig: typeof loadLLMConfig
	createLLMProvider: typeof createLLMProvider
	input: typeof inquirerInput
	/** Override for tests; defaults to reading ~/.baka/config.json. */
	getProvider?: (cwd: string) => Promise<LLMProvider>
}

const defaultDeps: RunModuleDesignDeps = {
	loadLLMConfig,
	createLLMProvider,
	input: inquirerInput,
}

export async function runModuleDesign(
	name: string,
	opts: { cwd: string; resume?: boolean },
	deps: RunModuleDesignDeps = defaultDeps,
): Promise<void> {
	if (!name) {
		die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka module create <name>")
	}
	if (!isValidModuleName(name)) {
		die(BAKA_EXIT_CODE.USER_ERROR, invalidModuleNameMessage())
	}

	const moduleDir = join(opts.cwd, "modules", name)
	const statePath = join(moduleDir, STATE_FILE)
	const existing = loadSession(moduleDir)
	if (existing) {
		console.log(`\n[resuming design session for ${name} — phase: ${existing.phase}]\n`)
		console.log(renderResumeContext(existing))
	} else {
		const brief =
			isE2EMode() && process.env.BAKA_E2E_BRIEF
				? process.env.BAKA_E2E_BRIEF
				: await deps.input({
						message: `In one or two sentences, what should the module "${name}" do?`,
						validate: (v) => (v.trim().length > 5 ? true : "give me a bit more"),
					})
		console.log(renderBriefEcho(brief))
		const fresh = createInitialState({ moduleName: name, brief })
		saveSession(fresh, moduleDir)
	}

	const config = await deps.loadLLMConfig({ cwd: opts.cwd })
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
		onStateChanged: (state) => saveSession(state, moduleDir),
		runConsistency: (n, intent) => runConsistencyInSandbox({ n, intent, moduleName: name, moduleDir, cwd: opts.cwd }),
	}

	const result: ChatLoopResult = await runChatLoop({
		provider,
		moduleDir,
		hooks,
		brief: existing?.brief ?? loadSession(moduleDir)?.brief,
	})

	if (result.exited === "done") {
		console.log(`\n[module ${name} delivered; CONSISTENCY.md has the trace]\n`)
	} else if (result.exited === "consistency-failure") {
		console.log(`\n[consistency failed; module ${name} left in DEVELOP for refinement]\n`)
		process.exit(BAKA_EXIT_CODE.VALIDATION_ERROR)
	} else if (result.exited === "rejected") {
		console.log(`\n[deliver cancelled by user; module ${name} rolled back to DEVELOP]\n`)
	} else if (result.exited === "user-exit") {
		console.log(`\n[session saved to ${statePath}; resume with \`baka module create ${name}\`]\n`)
	}
}

export async function runModuleConsistency(
	name: string,
	opts: { cwd: string; actionId?: string; intent?: string; n?: number },
): Promise<void> {
	const moduleDir = join(opts.cwd, "modules", name)
	const state = loadSession(moduleDir)
	const actionId = opts.actionId ?? state?.designedActions?.[0]?.id
	if (!actionId) {
		die(BAKA_EXIT_CODE.USER_ERROR, `could not determine action id; pass --action=<id>`)
	}
	const intent =
		opts.intent ?? state?.designedActions?.find((a) => a.id === actionId)?.testIntent ?? `use ${name}:${actionId}`
	const n = opts.n ?? 5

	const sandbox = createModuleSandbox({ moduleName: name, moduleDir, cwd: opts.cwd })
	try {
		const { runConsistencyTest } = await import("@repo/ast-tooling")
		const result = await runConsistencyTest({ cwd: sandbox.tempDir, moduleName: name, actionId, intent, n })
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
