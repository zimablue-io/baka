import { engineRequest } from "@baka/engine"
import { createLLMProvider, loadLLMConfig, validateLLMConfig } from "@repo/agent-engine"
import { listPlans, loadPlan, ModuleRegistry, runValidators, StructuredLog, savePlan } from "@repo/ast-tooling"
import { featurePlanningWorkflow } from "@repo/feature-planning-workflow"
import type { LLMProvider, ModuleManifest, OrchestrationState, ResolvedLLMConfig, WorkflowStep } from "@repo/protocol"
import { BAKA_EXIT_CODE } from "@repo/protocol"
import { createJiti } from "jiti"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

interface PlanOpts {
	cwd?: string
	dryRun?: boolean
	save?: boolean
	json?: boolean
}

export async function runPlanCommand(intent: string, opts: PlanOpts): Promise<void> {
	const cwd = opts.cwd ?? process.cwd()
	if (intent.trim() === "") {
		const diagnostic = "no module matched: empty intent"
		if (opts.json) {
			const result: Record<string, unknown> = {
				status: "FAILED",
				steps: [],
				logs: [diagnostic],
			}
			console.log(JSON.stringify(result, null, 2))
		} else {
			console.log(`baka: ${diagnostic}`)
		}
		process.exit(BAKA_EXIT_CODE.ENGINE_ERROR)
	}
	let config: ResolvedLLMConfig
	try {
		config = await loadLLMConfig({ role: "worker", cwd })
	} catch (err) {
		die(BAKA_EXIT_CODE.USER_ERROR, err instanceof Error ? err.message : String(err))
	}
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
		savedPlanFile = savePlan(cwd, intent, { resolvedSteps: state.executionPlan.steps }, config.model)
		log.write({ level: "info", source: "baka.plan", message: "saved plan", file: savedPlanFile })
	}

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
		// Surface the engine's own diagnostics (e.g. an action-id collision
		// refusal) instead of a bare "see logs" pointer.
		for (const line of state.logs.filter((l) => l.startsWith("[plan]"))) {
			console.error(`baka: ${line}`)
		}
		die(BAKA_EXIT_CODE.ENGINE_ERROR, "planning failed; see logs for details")
	}

	if (savedPlanFile) {
		console.log(`\nsaved plan: ${savedPlanFile}`)
	}

	// Planning is intentionally non-mutating. The only execution path is `baka apply <plan-file>`.
	if (opts.dryRun) {
		console.log("\n(dry run: plan resolved but not saved or executed)")
		log.write({ level: "info", source: "baka.plan", message: "dry run; plan resolved but not executed" })
	} else {
		console.log("\nnext: run `baka plan --save` to persist, or `baka apply <plan-file>` to execute it.")
	}
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

export async function runApplyCommand(planFile: string, cwd: string, opts: { json?: boolean } = {}): Promise<void> {
	const plan = loadPlan(planFile)
	const runId = `apply-${Date.now()}`
	const log = new StructuredLog(runId)
	log.write({ level: "info", source: "baka.apply", message: "loading plan", file: planFile, intent: plan.meta.intent })

	// Resolve every module the plan references via the registry's
	// resolveModuleRoot path — the same path the Worker uses at
	// execution time. Unlike `discover()`, this is NOT gated on the
	// cwd's package.json, so a bare temp dir (no .baka/modules/ and no
	// in-tree modules/) still resolves whatever is installed for that
	// project. The apply surface and the worker surface therefore
	// resolve modules from any cwd identically.
	const { runSaga: runSagaImpl, executeWorkerStep } = await import("@repo/ast-tooling")
	const registry = new ModuleRegistry(cwd)
	const moduleNames = new Set<string>()
	for (const planStep of plan.resolvedSteps) {
		// Normalize the module name by stripping the version suffix the
		// planner emits (e.g. "hello v0.1.0" → "hello") since worker steps
		// are keyed by name only.
		moduleNames.add(planStep.module.split(" v")[0] ?? planStep.module)
	}
	const stepsByKey = new Map<string, WorkflowStep<unknown, unknown, unknown>>()
	const resolvedManifests = new Map<string, ModuleManifest>()
	let requiresReasoning = false
	for (const moduleName of moduleNames) {
		const moduleRoot = registry.resolveModuleRoot(moduleName)
		if (!moduleRoot) continue // saga will surface "no worker step registered for X:Y"
		const manifest = loadModuleManifest(moduleRoot, moduleName)
		if (!manifest) continue
		resolvedManifests.set(moduleName, manifest)
		for (const a of manifest.actions) {
			stepsByKey.set(`${moduleName}:${a.id}`, executeWorkerStep as unknown as WorkflowStep<unknown, unknown, unknown>)
		}
	}
	for (const planStep of plan.resolvedSteps) {
		const moduleName = planStep.module.split(" v")[0] ?? planStep.module
		const manifest = resolvedManifests.get(moduleName)
		if (!manifest) continue
		const action = manifest.actions.find((a) => a.id === planStep.action)
		if (action?.requiresReasoning) {
			requiresReasoning = true
			break
		}
	}

	// Only set up the LLM provider when a plan step actually needs it.
	// All-non-reasoning plans (the common case for deterministic
	// scaffold / install-config / lint runs) succeed with no LLM
	// config at all. Plans with a reasoning step demand the worker
	// role honestly — the missing-config error reaches the user
	// untouched.
	let provider: LLMProvider | null = null
	if (requiresReasoning) {
		let config: ResolvedLLMConfig
		try {
			config = await loadLLMConfig({ role: "worker", cwd })
		} catch (err) {
			die(BAKA_EXIT_CODE.USER_ERROR, err instanceof Error ? err.message : String(err))
		}
		provider = createLLMProvider(config)
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
	const usedModules = Array.from(new Set(saga.completed.map((c) => c.module)))
	const validation = await runValidators(cwd, saga.state, actionResults, undefined, usedModules)

	const completedSteps = saga.completed.map((c) => ({
		id: c.id,
		module: c.module,
		action: c.action,
		output: c.output,
	}))

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

/**
 * Load a module's manifest from disk via jiti. The apply command
 * resolves modules through ModuleRegistry.resolveModuleRoot (which
 * works from any cwd), then uses this helper to read each module's
 * `Manifest` export without depending on `discover()` (which gates
 * the bundled scope on a cwd `package.json` and would hide modules
 * from bare temp dirs).
 */
function loadModuleManifest(moduleRoot: string, _moduleName: string): ModuleManifest | null {
	const manifestPath = `${moduleRoot}/manifest.ts`
	const jiti = createJiti(moduleRoot, { interopDefault: true })
	const mod = jiti(manifestPath) as { Manifest?: ModuleManifest }
	if (!mod.Manifest) return null
	return mod.Manifest
}

export async function runValidateCommand(cwd: string, opts: { json?: boolean; module?: string } = {}): Promise<void> {
	const { status, json } = await engineRequest(cwd, "/v1/validate", {
		method: "POST",
		body: opts.module ? { module: opts.module } : {},
	})
	const body = json as {
		error?: string
		valid?: boolean
		modulesDiscovered?: number
		moduleName?: string
		validation?: {
			kind: "pass" | "fail"
			diagnostics?: Array<{ severity: string; rule: string; message: string }>
		}
	}
	if (status >= 400) {
		die(BAKA_EXIT_CODE.USER_ERROR, body.error ?? "validate failed")
	}
	const result = body.validation ?? { kind: body.valid === false ? "fail" : "pass", diagnostics: [] }

	if (result.kind === "fail") {
		const missingConfig = result.diagnostics?.find(
			(d) => d.severity === "error" && /missing LLM config/.test(d.message),
		)
		if (missingConfig) {
			die(BAKA_EXIT_CODE.USER_ERROR, missingConfig.message)
		}
	}

	if (opts.json) {
		const payload: Record<string, unknown> = {
			valid: result.kind !== "fail",
			modulesDiscovered: body.modulesDiscovered ?? 0,
			validation: result,
		}
		if (opts.module) payload.moduleName = opts.module
		console.log(JSON.stringify(payload, null, 2))
		if (result.kind === "fail") {
			process.exit(BAKA_EXIT_CODE.VALIDATION_ERROR)
		}
		return
	}

	console.log(`discovered ${body.modulesDiscovered ?? 0} module(s)`)
	if (opts.module) console.log(`filtered to module: ${opts.module}`)
	if (result.kind === "pass") {
		console.log("\nvalidation: PASS")
		return
	}
	console.log("\nvalidation: FAIL")
	for (const d of result.diagnostics ?? []) {
		console.log(`  - [${d.severity}] ${d.rule}: ${d.message}`)
	}
	process.exit(BAKA_EXIT_CODE.VALIDATION_ERROR)
}
