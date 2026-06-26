import { createLLMProvider, loadLLMConfig, validateLLMConfig } from "@repo/agent-engine"
import { listPlans, loadPlan, ModuleRegistry, runValidators, StructuredLog, savePlan } from "@repo/ast-tooling"
import { discoverModules } from "@repo/discovery-workflow"
import { featurePlanningWorkflow } from "@repo/feature-planning-workflow"
import type { LLMProvider, OrchestrationState, WorkflowStep } from "@repo/protocol"
import { BAKA_EXIT_CODE } from "@repo/protocol"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

interface PlanOpts {
	provider?: string
	cwd?: string
	dryRun?: boolean
	save?: boolean
	json?: boolean
}

export async function runPlanCommand(intent: string, opts: PlanOpts): Promise<void> {
	const cwd = opts.cwd ?? process.cwd()
	const config = await loadLLMConfig({ cwd, providerName: opts.provider })
	try {
		validateLLMConfig(config)
	} catch (err) {
		die(BAKA_EXIT_CODE.USER_ERROR, err instanceof Error ? err.message : String(err))
	}
	let provider: LLMProvider
	try {
		provider = createLLMProvider(config)
	} catch (err) {
		die(BAKA_EXIT_CODE.PROVIDER_ERROR, err instanceof Error ? err.message : String(err))
	}

	const runId = `plan-${Date.now()}`
	const log = new StructuredLog(runId)
	log.write({ level: "info", source: "baka.plan", message: "starting plan", intent, runId })

	const state = await featurePlanningWorkflow(intent, cwd, provider)

	// --save runs BEFORE the JSON-mode early-return so `--save --json` together
	// emits both the documented JSON contract AND the persisted .plan.json file.
	// The contract requires both behaviors to coexist (VAL-CLI-023). Save only
	// on successful plans — matches the previous human-mode semantics where
	// the FAILED branch exits before reaching the save call.
	let savedPlanFile: string | null = null
	if (opts.save && state.status !== "FAILED") {
		savedPlanFile = savePlan(
			cwd,
			intent,
			{ resolvedSteps: state.executionPlan.steps },
			config.providerOptions.name as string,
			config.model,
		)
		log.write({ level: "info", source: "baka.plan", message: "saved plan", file: savedPlanFile })
	}

	// JSON mode: emit the same shape the MCP `baka_plan` tool returns, then
	// exit. Suppress the human-formatted output so agents can pipe stdout
	// straight into `jq`. When --save was also set, include `planFile` and
	// `savedAt` so the JSON output identifies what was persisted.
	if (opts.json) {
		const result: Record<string, unknown> = {
			status: state.status === "FAILED" ? "FAILED" : "SUCCESS",
			steps: state.executionPlan.steps,
			logs: state.logs,
		}
		if (savedPlanFile) {
			result.planFile = savedPlanFile
			result.savedAt = new Date().toISOString()
		}
		console.log(JSON.stringify(result, null, 2))
		if (state.status === "FAILED") {
			process.exit(BAKA_EXIT_CODE.ENGINE_ERROR)
		}
		return
	}

	console.log(`\nplan: ${state.executionPlan.steps.length} step(s)`)
	for (const step of state.executionPlan.steps) {
		console.log(`  - ${step.module}:${step.action}`)
	}

	if (state.status === "FAILED") {
		log.write({ level: "error", source: "baka.plan", message: "plan failed", intent, logs: state.logs })
		die(BAKA_EXIT_CODE.ENGINE_ERROR, "planning failed; see logs for details")
	}

	if (savedPlanFile) {
		console.log(`\nsaved plan: ${savedPlanFile}`)
	}

	if (opts.dryRun) {
		console.log("\n(dry run: not executing the plan)")
		log.write({ level: "info", source: "baka.plan", message: "dry run; not executing" })
		return
	}

	// Phase 7: --execute actually runs the plan.
	const execute = process.argv.includes("--execute")
	if (!execute) {
		console.log("\nnext: run `baka plan --save` to persist, or `baka plan --execute` to run it.")
		return
	}

	log.write({ level: "info", source: "baka.plan.execute", message: "executing plan" })
	const registry = new ModuleRegistry(cwd)
	registry.discover(false)
	const stepsByKey = new Map<string, WorkflowStep<unknown, unknown, unknown>>()
	for (const m of registry.all()) {
		for (const a of m.actions) {
			// The SAGA key is moduleName:actionId; the worker step we use for
			// every action is the same generic executeWorkerStep. Future phases
			// can specialize per action.
			stepsByKey.set(`${m.name}:${a.id}`, /* will resolve at saga time */ {} as WorkflowStep<unknown, unknown, unknown>)
		}
	}
	// We can't easily inject the Worker here without circular imports; defer to apply.
	console.log("use `baka apply <plan-file>` to execute a saved plan (coming online in Phase 7).")
}

export function runListPlans(cwd: string): void {
	const plans = listPlans(cwd)
	if (plans.length === 0) {
		console.log("no saved plans; use `baka plan --save` to create one")
		return
	}
	console.log(`\n${plans.length} plan(s):\n`)
	for (const p of plans) {
		console.log(`  ${p.file}`)
		console.log(`    intent:  ${p.meta.intent}`)
		console.log(`    savedAt: ${p.meta.savedAt}`)
	}
	console.log("")
}

export async function runApplyCommand(
	planFile: string,
	cwd: string,
	opts: { json?: boolean; provider?: string } = {},
): Promise<void> {
	const plan = loadPlan(planFile)
	const runId = `apply-${Date.now()}`
	const log = new StructuredLog(runId)
	log.write({ level: "info", source: "baka.apply", message: "loading plan", file: planFile, intent: plan.meta.intent })

	// Build the LLM provider for the requiresReasoning steps.
	const config = await loadLLMConfig({ cwd, providerName: opts.provider ?? plan.meta.providerName })
	const provider = createLLMProvider(config)

	// Reuse the SAGA: the workflow package exposes runSaga indirectly via
	// plan-intent's executePlan helper. For Phase 7 we wire it directly.
	const { runSaga: runSagaImpl } = await import("@repo/ast-tooling")
	const { executeWorkerStep } = await import("@repo/ast-tooling")
	const registry = new ModuleRegistry(cwd)
	registry.discover(false)
	const stepsByKey = new Map<string, WorkflowStep<unknown, unknown, unknown>>()
	for (const m of registry.all()) {
		for (const a of m.actions) {
			stepsByKey.set(`${m.name}:${a.id}`, executeWorkerStep as unknown as WorkflowStep<unknown, unknown, unknown>)
		}
	}

	const state: OrchestrationState = {
		userIntent: plan.meta.intent,
		targetDirectory: cwd,
		status: "PLANNING",
		executionPlan: { steps: plan.resolvedSteps, currentStepIndex: 0 },
		logs: ["[apply] starting"],
		artifacts: {},
	}
	const saga = await runSagaImpl(plan, state, { llmProvider: provider }, stepsByKey)
	log.write({ level: "info", source: "baka.apply", message: "saga finished", status: saga.state.status })

	// Post-apply: run validators, including action-level ones that need the
	// compensation data each step returned (so they can assert on what was
	// actually produced, not just the structural shape).
	const actionResults = new Map<string, { compensationData: unknown }>()
	for (const c of saga.completed) {
		actionResults.set(`${c.module}:${c.action}`, { compensationData: c.compensationData })
	}
	const validation = await runValidators(cwd, saga.state, actionResults)

	const completedSteps = saga.completed.map((c) => ({ id: c.id, module: c.module, action: c.action }))

	if (opts.json) {
		// Same shape as the MCP `baka_apply` tool.
		const status = saga.failed ? "FAILED" : validation.kind === "fail" ? "VALIDATION_FAILED" : "SUCCESS"
		const result = { status, completedSteps, failed: saga.failed, validation, logs: saga.state.logs }
		console.log(JSON.stringify(result, null, 2))
		if (saga.failed) {
			process.exit(BAKA_EXIT_CODE.ENGINE_ERROR)
		}
		if (validation.kind === "fail") {
			process.exit(BAKA_EXIT_CODE.VALIDATION_ERROR)
		}
		return
	}

	if (saga.failed) {
		die(BAKA_EXIT_CODE.ENGINE_ERROR, `apply failed: ${saga.failed.error}`)
	}
	if (validation.kind === "fail") {
		console.log("\napply: VALIDATION FAILED")
		for (const d of validation.diagnostics) {
			console.log(`  - [${d.severity}] ${d.rule}: ${d.message}`)
		}
		process.exit(BAKA_EXIT_CODE.VALIDATION_ERROR)
	}
	console.log("\napply: success (validators passed)")
}

export async function runValidateCommand(cwd: string, opts: { json?: boolean } = {}): Promise<void> {
	const modules = discoverModules(cwd)
	const state: OrchestrationState = {
		userIntent: "(validate)",
		targetDirectory: cwd,
		status: "VALIDATING",
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: [],
		artifacts: {},
	}
	const result = await runValidators(cwd, state)

	if (opts.json) {
		// Same shape as the MCP `baka_validate` tool.
		console.log(JSON.stringify({ modulesDiscovered: modules.length, validation: result }, null, 2))
		if (result.kind === "fail") {
			process.exit(BAKA_EXIT_CODE.VALIDATION_ERROR)
		}
		return
	}

	console.log(`discovered ${modules.length} module(s)`)
	if (result.kind === "pass") {
		console.log("\nvalidation: PASS")
		return
	}
	console.log("\nvalidation: FAIL")
	for (const d of result.diagnostics) {
		console.log(`  - [${d.severity}] ${d.rule}: ${d.message}`)
	}
	process.exit(BAKA_EXIT_CODE.VALIDATION_ERROR)
}
