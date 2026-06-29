import { createLLMProvider, loadLLMConfig, validateLLMConfig } from "@repo/agent-engine"
import { executeWorkerStep, loadPlan, ModuleRegistry, runSaga, runValidators } from "@repo/ast-tooling"
import { discoverModules } from "@repo/discovery-workflow"
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
import { getModules } from "../context.js"

type ResolvedPlanStep = z.infer<typeof ResolvedPlanStepSchema>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve and validate the LLM provider. Mirrors `baka plan` / `baka apply`'s
 * setup. Throws a clear error if the config is missing so the MCP client
 * surfaces a useful message instead of a generic "execution failed".
 */
async function setupProvider(ctx: ServerContext, providerName?: string): Promise<LLMProvider> {
	const config = await loadLLMConfig({ cwd: ctx.cwd, providerName, skipCredentials: false })
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

export interface PlanToolOutput {
	status: "SUCCESS" | "FAILED"
	steps: ResolvedPlanStep[]
	logs: string[]
}

export async function runPlan(
	ctx: ServerContext,
	intent: string,
	opts: { dryRun?: boolean; save?: boolean; provider?: string } = {},
): Promise<PlanToolOutput> {
	const provider = await setupProvider(ctx, opts.provider)
	const state = await featurePlanningWorkflow(intent, ctx.cwd, provider)
	return {
		status: state.status === "FAILED" ? "FAILED" : "SUCCESS",
		steps: state.executionPlan.steps,
		logs: state.logs,
	}
}

// ---------------------------------------------------------------------------
// baka_apply
// ---------------------------------------------------------------------------

export interface ApplyToolOutput {
	status: "SUCCESS" | "FAILED" | "VALIDATION_FAILED"
	completedSteps: Array<{ id: string; module: string; action: string }>
	failed: { id: string; error: string } | null
	validation: ValidationResult
	logs: string[]
}

export async function runApply(
	ctx: ServerContext,
	planFile: string,
	opts: { provider?: string } = {},
): Promise<ApplyToolOutput> {
	const plan = loadPlan(planFile)
	const provider = await setupProvider(ctx, opts.provider)

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
	const validation = await runValidators(ctx.cwd, saga.state, actionResults, undefined, usedModules)

	const completedSteps = saga.completed.map((c) => ({
		id: c.id,
		module: c.module,
		action: c.action,
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

// ---------------------------------------------------------------------------
// baka_validate
// ---------------------------------------------------------------------------

export interface ValidateToolOutput {
	modulesDiscovered: number
	validation: ValidationResult
}

export async function runValidate(ctx: ServerContext): Promise<ValidateToolOutput> {
	const modules = discoverModules(ctx.cwd)
	const state: OrchestrationState = {
		userIntent: "(validate)",
		targetDirectory: ctx.cwd,
		status: "VALIDATING",
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: [],
		artifacts: {},
	}
	const validation = await runValidators(ctx.cwd, state)
	return { modulesDiscovered: modules.length, validation }
}

// ---------------------------------------------------------------------------
// baka_list_actions
// ---------------------------------------------------------------------------

export interface ListActionsToolOutput {
	module: string
	version: string
	description: string
	actions: Array<{
		id: string
		description: string
		requiresReasoning: boolean
		compensatesWith?: string
		params: Array<{
			name: string
			type: string
			required: boolean
			description: string
			enumValues?: string[]
		}>
	}>
}

export async function runListActions(ctx: ServerContext, moduleName: string): Promise<ListActionsToolOutput> {
	const m = getModules(ctx).find((x) => x.name === moduleName)
	if (!m) {
		const known = getModules(ctx)
			.map((x) => x.name)
			.join(", ")
		throw new Error(`module "${moduleName}" not found. Discovered modules: ${known || "(none)"}`)
	}
	return {
		module: m.name,
		version: m.version,
		description: m.description,
		actions: m.actions.map((a) => ({
			id: a.id,
			description: a.description,
			requiresReasoning: a.requiresReasoning,
			...(a.compensatesWith ? { compensatesWith: a.compensatesWith } : {}),
			params: a.params.map((p) => ({
				name: p.name,
				type: p.type,
				required: p.required,
				description: p.description,
				...(p.enumValues ? { enumValues: p.enumValues } : {}),
			})),
		})),
	}
}

// ---------------------------------------------------------------------------
// Per-action execution
// ---------------------------------------------------------------------------

export interface RunActionToolOutput {
	success: boolean
	module: string
	action: string
	output?: unknown
	error?: string
}

export async function runAction(
	ctx: ServerContext,
	moduleName: string,
	actionId: string,
	params: Record<string, unknown>,
	opts: { provider?: string } = {},
): Promise<RunActionToolOutput> {
	const manifest = getModules(ctx).find((m) => m.name === moduleName)
	if (!manifest) {
		throw new Error(`module "${moduleName}" not found`)
	}
	const action = manifest.actions.find((a) => a.id === actionId)
	if (!action) {
		throw new Error(`action "${actionId}" not declared in module "${moduleName}"`)
	}

	// Only load the LLM provider if any action in the manifest requires
	// reasoning. The worker throws a clear error if a specific action
	// requires reasoning but no provider is supplied.
	let provider: LLMProvider | null = null
	if (manifest.actions.some((a) => a.requiresReasoning)) {
		provider = await setupProvider(ctx, opts.provider)
	}

	const state: OrchestrationState = {
		userIntent: `mcp://${moduleName}:${actionId}`,
		targetDirectory: ctx.cwd,
		status: "EXECUTING",
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: [],
		artifacts: {},
	}

	const result = await executeWorkerStep.execute({ moduleName, actionName: actionId, parameters: params }, state, {
		llmProvider: provider,
	})
	if (!result.success) {
		return {
			success: false,
			module: moduleName,
			action: actionId,
			error: result.error ?? "action returned success: false",
		}
	}
	return {
		success: true,
		module: moduleName,
		action: actionId,
		output: result.output,
	}
}
