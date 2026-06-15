import { randomUUID } from "node:crypto"
import { z } from "zod"

// ---------------------------------------------------------------------------
// Local `defineHook` that mirrors the workflow-sdk API exactly.
//
// We can't use `workflow`'s `defineHook` directly in a CLI process: the SDK
// is designed for long-running hosted runtimes (Next.js, etc.) where the
// hook is persisted across requests. For a CLI, the hook lives in the
// same process as the user, so the "create + resume" is in-memory.
//
// The shape is identical to `workflow`'s:
//   const myHook = defineHook<{ approved: boolean; comment?: string }>()
//   const handle = myHook.create()
//   // ...later, in another turn...
//   myHook.resume("approval-1", { approved: true, comment: "ok" })
//   const result = await handle   // -> { approved: true, comment: "ok" }
//
// All the design-flow approval gates (user input, define roster approval,
// develop per-action approval, deliver approval) go through hooks. The
// CLI resumes each hook when the user types. Tests resume hooks
// programmatically.
//
// If/when we want a hosted chat UI (Next.js + Workflow SDK), the same
// `defineHook` calls work — swap the local implementation for the real
// `workflow.defineHook` and nothing else changes.
// ---------------------------------------------------------------------------

export interface StandardSchemaV1<Input, Output> {
	readonly "~standard": {
		readonly version: 1
		readonly vendor: string
		readonly validate: (value: unknown) =>
			| { value: Output; issues?: undefined }
			| { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }> }
		readonly types?: {
			readonly input: Input
			readonly output: Output
		}
	}
}

export interface HookDefinition<TInput, TOutput> {
	/**
	 * Create a new hook instance. The returned value is a Promise (you can
	 * `await` it) that resolves when `resume()` is called with the matching
	 * token. The returned instance also exposes the `token` for the resume
	 * side to use.
	 */
	create(options?: { token?: string }): HookInstance<TOutput>
	/**
	 * Resume a pending hook. Validates the payload with the optional
	 * schema before resolving. Throws if no hook is pending with the given
	 * token, or if schema validation fails.
	 */
	resume(token: string, payload: TInput): void
	/**
	 * Reject a pending hook with an error. Useful for "user cancelled" or
	 * validation failure paths.
	 */
	reject(token: string, reason: Error): void
	/**
	 * Test/debug helper: get the number of pending hooks.
	 */
	pendingCount(): number
	/**
	 * Test/debug helper: clear all pending hooks. The CLI never calls
	 * this; tests do, between cases.
	 */
	_clear(): void
	/**
	 * Test/debug helper: list pending hook tokens. For diagnostics.
	 */
	pendingTokens(): string[]
}

export interface HookInstance<TOutput> extends Promise<TOutput> {
	readonly token: string
}

interface Pending<TOutput> {
	resolve: (value: TOutput) => void
	reject: (reason: Error) => void
}

export function defineHook<TInput, TOutput = TInput>(opts?: {
	schema?: StandardSchemaV1<TInput, TOutput>
}): HookDefinition<TInput, TOutput> {
	const pending = new Map<string, Pending<TOutput>>()

	function validate(payload: TInput): TOutput {
		if (!opts?.schema) return payload as unknown as TOutput
		const result = opts.schema["~standard"].validate(payload)
		if ("issues" in result && result.issues && result.issues.length > 0) {
			const issues = result.issues
				.map((i) => `${i.path?.map((p) => String(p)).join(".") || "(root)"}: ${i.message}`)
				.join("; ")
			throw new Error(`hook payload validation failed: ${issues}`)
		}
		return (result as { value: TOutput }).value
	}

	return {
		create(options) {
			const token = options?.token ?? randomUUID()
			const promise = new Promise<TOutput>((resolve, reject) => {
				pending.set(token, { resolve, reject })
			})
			const hook = promise as HookInstance<TOutput>
			Object.defineProperty(hook, "token", { value: token, enumerable: true })
			return hook
		},
		resume(token, payload) {
			const slot = pending.get(token)
			if (!slot) {
				throw new Error(`hook token "${token}" is not pending (already resumed? wrong scope?)`)
			}
			pending.delete(token)
			slot.resolve(validate(payload))
		},
		reject(token, reason) {
			const slot = pending.get(token)
			if (!slot) {
				throw new Error(`hook token "${token}" is not pending`)
			}
			pending.delete(token)
			slot.reject(reason)
		},
		pendingCount() {
			return pending.size
		},
		pendingTokens() {
			return [...pending.keys()]
		},
		_clear() {
			for (const [, slot] of pending) slot.reject(new Error("hook cleared"))
			pending.clear()
		},
	}
}

// ---------------------------------------------------------------------------
// Zod adapter. A Zod schema implements the Standard Schema v1 interface
// via the `z.object(...).~standard` accessor since zod 3.24+. We adapt
// it to a Standard Schema v1 record.
// ---------------------------------------------------------------------------

export function zodSchema<TInput, TOutput>(schema: z.ZodType<TOutput, z.ZodTypeDef, TInput>): StandardSchemaV1<TInput, TOutput> {
	return {
		"~standard": {
			version: 1,
			vendor: "zod",
			validate: (value: unknown) => {
				const r = schema.safeParse(value)
				if (r.success) return { value: r.data }
				return {
					issues: r.error.issues.map((i) => ({
						message: i.message,
						path: i.path,
					})),
				}
			},
		},
	}
}

// ---------------------------------------------------------------------------
// The design-flow hooks. Each one models a HITL pause point in the
// double-diamond design flow.
//
//   userInputHook     — the user types a free-form message (the chat REPL's
//                       primary input mechanism). Resolved when the CLI
//                       resumes with the typed text.
//   defineApprovalHook — the LLM has proposed an action roster; the user
//                        must approve (or send back) before DEVELOP.
//   developApprovalHook — the LLM has designed the action; the user must
//                         approve (or send back) before DELIVER.
//   deliverApprovalHook — the workflow is about to write files + run the
//                         5x consistency test. The user gets a final
//                         confirmation.
//
// Every hook has a Zod schema so the resume payload is validated. The
// schema is the contract between the workflow (which awaits the hook)
// and the CLI (which resumes the hook when the user types).
// ---------------------------------------------------------------------------

export const userInputHook = defineHook<{ text: string; cancelled: boolean }>({
	schema: zodSchema(
		z.object({
			text: z.string(),
			cancelled: z.boolean(),
		}),
	),
})

export const defineApprovalHook = defineHook<{ approved: boolean; note?: string }>({
	schema: zodSchema(
		z.object({
			approved: z.boolean(),
			note: z.string().optional(),
		}),
	),
})

export const developApprovalHook = defineHook<{ approved: boolean; edits?: string }>({
	schema: zodSchema(
		z.object({
			approved: z.boolean(),
			edits: z.string().optional(),
		}),
	),
})

export const deliverApprovalHook = defineHook<{ approved: boolean }>({
	schema: zodSchema(
		z.object({
			approved: z.boolean(),
		}),
	),
})
