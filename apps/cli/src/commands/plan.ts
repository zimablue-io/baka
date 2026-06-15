import { BAKA_EXIT_CODE } from "@repo/protocol"
import { createLLMProvider, loadLLMConfig, validateLLMConfig } from "@repo/agent-engine"
import { ModuleRegistry, runSaga, runValidators, savePlan, loadPlan, listPlans, StructuredLog } from "@repo/ast-tooling"
import { featurePlanningWorkflow } from "@repo/feature-planning-workflow"
import type { LLMProvider, OrchestrationState, WorkflowStep } from "@repo/protocol"
import { discoverModules } from "@repo/discovery-workflow"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

interface PlanOpts {
	provider?: string
	cwd?: string
	dryRun?: boolean
	save?: boolean
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
	console.log(`\nplan: ${state.executionPlan.steps.length} step(s)`)
	for (const step of state.executionPlan.steps) {
		console.log(`  - ${step.module}:${step.action}`)
	}

	if (state.status === "FAILED") {
		log.write({ level: "error", source: "baka.plan", message: "plan failed", intent, logs: state.logs })
		die(BAKA_EXIT_CODE.ENGINE_ERROR, "planning failed; see logs for details")
	}

	if (opts.save) {
		const file = savePlan(
			cwd,
			intent,
			{ resolvedSteps: state.executionPlan.steps },
			config.providerOptions.name as string,
			config.model,
		)
		log.write({ level: "info", source: "baka.plan", message: "saved plan", file })
		console.log(`\nsaved plan: ${file}`)
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

export async function runApplyCommand(planFile: string, cwd: string): Promise<void> {
	const plan = loadPlan(planFile)
	const runId = `apply-${Date.now()}`
	const log = new StructuredLog(runId)
	log.write({ level: "info", source: "baka.apply", message: "loading plan", file: planFile, intent: plan.meta.intent })

	// Build the LLM provider for the requiresReasoning steps.
	const config = await loadLLMConfig({ cwd, providerName: plan.meta.providerName })
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

	if (saga.failed) {
		die(BAKA_EXIT_CODE.ENGINE_ERROR, `apply failed: ${saga.failed.error}`)
	}

	// Post-apply: run validators, including action-level ones that need the
	// compensation data each step returned (so they can assert on what was
	// actually produced, not just the structural shape).
	const actionResults = new Map<string, { compensationData: unknown }>()
	for (const c of saga.completed) {
		actionResults.set(`${c.module}:${c.action}`, { compensationData: c.compensationData })
	}
	const validation = await runValidators(cwd, saga.state, actionResults)
	if (validation.kind === "fail") {
		console.log("\napply: VALIDATION FAILED")
		for (const d of validation.diagnostics) {
			console.log(`  - [${d.severity}] ${d.rule}: ${d.message}`)
		}
		process.exit(BAKA_EXIT_CODE.VALIDATION_ERROR)
	}
	console.log("\napply: success (validators passed)")
}

export async function runValidateCommand(cwd: string): Promise<void> {
	const modules = discoverModules(cwd)
	console.log(`discovered ${modules.length} module(s)`)
	const state: OrchestrationState = {
		userIntent: "(validate)",
		targetDirectory: cwd,
		status: "VALIDATING",
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: [],
		artifacts: {},
	}
	const result = await runValidators(cwd, state)
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
