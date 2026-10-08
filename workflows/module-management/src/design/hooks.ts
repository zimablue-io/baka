import { randomUUID } from "node:crypto"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { z } from "zod"

// The Standard Schema contract is the one `@standard-schema/spec` publishes, so a schema written by any
// library that implements it is accepted here as it stands. Re-exported because it is part of this module's
// surface: a caller declaring a hook's schema type needs the same interface the hook reads.
export type { StandardSchemaV1 } from "@standard-schema/spec"

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

	function validate(payload: TInput): Promise<TOutput> {
		if (!opts?.schema) return Promise.resolve(payload as unknown as TOutput)
		// The Standard Schema contract lets a validator answer with a promise, so the result is settled either way.
		return Promise.resolve(opts.schema["~standard"].validate(payload)).then((result) => {
			if ("issues" in result && result.issues && result.issues.length > 0) {
				const issues = result.issues
					.map((i) => `${i.path?.map((p) => String(p)).join(".") || "(root)"}: ${i.message}`)
					.join("; ")
				throw new Error(`hook payload validation failed: ${issues}`)
			}
			return (result as { value: TOutput }).value
		})
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
			// The payload is settled by whoever is awaiting the hook: a payload the schema refuses rejects it,
			// so the caller awaiting `create()` sees why rather than waiting on a decision that will not come.
			validate(payload).then(
				(value) => slot.resolve(value),
				(error: unknown) => slot.reject(error instanceof Error ? error : new Error(String(error))),
			)
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
// Schemas are handed to `defineHook` as they are. A Zod schema implements the
// Standard Schema v1 interface through its own `~standard` accessor, so there
// is no adapter here to keep in step with Zod: `defineHook` reads nothing but
// `~standard.validate`.
// ---------------------------------------------------------------------------

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
	schema: z.object({
		text: z.string(),
		cancelled: z.boolean(),
	}),
})

export const defineApprovalHook = defineHook<{ approved: boolean; note?: string }>({
	schema: z.object({
		approved: z.boolean(),
		note: z.string().optional(),
	}),
})

export const developApprovalHook = defineHook<{ approved: boolean; edits?: string }>({
	schema: z.object({
		approved: z.boolean(),
		edits: z.string().optional(),
	}),
})

export const deliverApprovalHook = defineHook<{ approved: boolean }>({
	schema: z.object({
		approved: z.boolean(),
	}),
})
