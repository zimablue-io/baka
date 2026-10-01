import { createLLMProvider, loadLLMConfig, validateLLMConfig } from "@repo/agent-engine"
import { executeWorkerStep, loadPlan, ModuleRegistry, runSaga, runValidators, savePlan } from "@repo/ast-tooling"
import { featurePlanningWorkflow } from "@repo/feature-planning-workflow"
import type {
	LLMProvider,
	OrchestrationState,
	ResolvedPlanStepSchema,
	ValidationResult,
	WorkflowStep,
} from "@repo/protocol"
import type { z } from "zod"
import type { ServerContext } from "../context.js"

type ResolvedPlanStep = z.infer<typeof ResolvedPlanStepSchema>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve and validate the LLM provider. Mirrors `baka plan` / `baka apply`'s
 * setup. Throws a clear error if the config is missing so the MCP client
 * surfaces a useful message instead of a generic "execution failed".
 */
async function setupProvider(ctx: ServerContext): Promise<LLMProvider> {
	const config = await loadLLMConfig({ role: "worker", cwd: ctx.cwd })
	try {
		validateLLMConfig(config)
	} catch (err) {
		throw new Error(`${err instanceof Error ? err.message : String(err)}. Run \`baka init\` to configure a provider.`)
	}
	return createLLMProvider(config)
}

// ---------------------------------------------------------------------------
// baka_plan
// ---------------------------------------------------------------------------

interface PlanToolOutput {
	status: "SUCCESS" | "FAILED"
	steps: ResolvedPlanStep[]
	logs: string[]
	planFile?: string
	savedAt?: string
}

export async function runPlan(
	ctx: ServerContext,
	intent: string,
	opts: { dryRun?: boolean; save?: boolean } = {},
): Promise<PlanToolOutput> {
	const config = await loadLLMConfig({ role: "worker", cwd: ctx.cwd })
	try {
		validateLLMConfig(config)
	} catch (err) {
		throw new Error(`${err instanceof Error ? err.message : String(err)}. Run \`baka init\` to configure a provider.`)
	}
	const provider = createLLMProvider(config)

	const state = await featurePlanningWorkflow(intent, ctx.cwd, provider)

	let planFile: string | undefined
	let savedAt: string | undefined
	if (opts.save && state.status !== "FAILED") {
		planFile = savePlan(ctx.cwd, intent, { resolvedSteps: state.executionPlan.steps }, config.model)
		savedAt = new Date().toISOString()
	}

	return {
		status: state.status === "FAILED" ? "FAILED" : "SUCCESS",
		steps: state.executionPlan.steps,
		logs: state.logs,
		planFile,
		savedAt,
	}
}

// ---------------------------------------------------------------------------
// baka_apply
// ---------------------------------------------------------------------------

interface ApplyToolOutput {
	status: "SUCCESS" | "FAILED" | "VALIDATION_FAILED"
	completedSteps: Array<{ id: string; module: string; action: string; output: unknown }>
	failed: { id: string; error: string } | null
	validation: ValidationResult
	logs: string[]
}

export async function runApply(
	ctx: ServerContext,
	planFile: string,
	_opts: Record<string, never> = {},
): Promise<ApplyToolOutput> {
	const plan = loadPlan(planFile)
	const provider = await setupProvider(ctx)

	const registry = new ModuleRegistry(ctx.cwd)
	registry.discover(false)
	const stepsByKey = new Map<string, WorkflowStep<unknown, unknown, unknown>>()
	for (const m of registry.all()) {
		for (const a of m.actions) {
			stepsByKey.set(`${m.name}:${a.id}`, executeWorkerStep as unknown as WorkflowStep<unknown, unknown, unknown>)
		}
	}

	const state: OrchestrationState = {
		userIntent: plan.meta.intent,
		targetDirectory: ctx.cwd,
		status: "PLANNING",
		executionPlan: { steps: plan.resolvedSteps, currentStepIndex: 0 },
		logs: ["[apply] starting"],
		artifacts: {},
	}
	const saga = await runSaga(plan, state, { llmProvider: provider }, stepsByKey)

	const actionResults = new Map<string, { compensationData: unknown }>()
	for (const c of saga.completed) {
		actionResults.set(`${c.module}:${c.action}`, { compensationData: c.compensationData })
	}
	// Scope the post-apply validators to the modules whose actions
	// actually ran in the SAGA. Mirrors the CLI apply behavior in
	// `apps/cli/src/commands/plan.ts:runApplyCommand` so the MCP and
	// CLI agree on which validators run. See the `moduleFilter` comment
	// in `packages/ast-tooling/src/validator.ts` for the rationale.
	const usedModules = Array.from(new Set(saga.completed.map((c) => c.module)))
	const validation = await runValidators(registry, saga.state, actionResults, undefined, usedModules)

	const completedSteps = saga.completed.map((c) => ({
		id: c.id,
		module: c.module,
		action: c.action,
		output: c.output,
	}))

	if (saga.failed) {
		return { status: "FAILED", completedSteps, failed: saga.failed, validation, logs: saga.state.logs }
	}
	if (validation.kind === "fail") {
		return {
			status: "VALIDATION_FAILED",
			completedSteps,
			failed: null,
			validation,
			logs: saga.state.logs,
		}
	}
	return { status: "SUCCESS", completedSteps, failed: null, validation, logs: saga.state.logs }
}
