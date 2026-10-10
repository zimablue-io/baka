// Boundary tests for the baka-sdk public surface. Pack authors import only
// from this package, so these tests exercise exactly what a pack sees:
//   - the WorkflowStep contract (execute/compensate) as the engine drives it
//   - callLLMAsValidator, the one-shot validator-role LLM helper, against a
//     real local HTTP server (no mocks): config load, wire shape, schema
//     validation, and the honest failure when the validator role is absent
//
// Hermetic: fake $HOME per test, server bound to 127.0.0.1:0, all fixtures
// under $TMPDIR and removed in afterEach.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { AgentRole, callLLMAsValidator, type OrchestrationState, type StepResponse, type WorkflowStep } from "./index"

// ---------------------------------------------------------------------------
// Fixture hygiene
// ---------------------------------------------------------------------------

const cleanup: string[] = []
const servers: Server[] = []
const prevHome = process.env.HOME

afterEach(async () => {
	process.env.HOME = prevHome
	for (const s of servers.splice(0)) {
		await new Promise<void>((res) => {
			s.close(() => res())
		})
	}
	for (const d of cleanup.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	}
})

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	cleanup.push(dir)
	return dir
}

function useFakeHome(prefix: string): string {
	const home = makeTempDir(prefix)
	process.env.HOME = home
	return home
}

function seedValidatorRole(home: string, baseUrl: string): void {
	const dir = join(home, ".baka")
	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify(
			{
				validator: {
					baseUrl,
					model: "validator-model",
					apiKey: "test-validator-key",
					temperature: 0,
					maxTokens: 8192,
					timeoutMs: 120000,
				},
			},
			null,
			2,
		),
	)
}

function makeState(targetDirectory: string): OrchestrationState {
	return {
		userIntent: "test",
		targetDirectory,
		status: "EXECUTING",
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: [],
		artifacts: {},
	} as OrchestrationState
}

// ---------------------------------------------------------------------------
// Fake LLM (OpenAI-compatible). Captures each request body for wire assertions.
// ---------------------------------------------------------------------------

interface CapturedRequest {
	path: string
	authorization: string
	body: Record<string, unknown>
}

function startFakeLLM(content: unknown): Promise<{ url: string; requests: CapturedRequest[] }> {
	const requests: CapturedRequest[] = []
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let raw = ""
		req.on("data", (chunk: Buffer) => (raw += chunk))
		req.on("end", () => {
			requests.push({
				path: req.url ?? "",
				authorization: String(req.headers.authorization ?? ""),
				body: JSON.parse(raw) as Record<string, unknown>,
			})
			res.setHeader("Content-Type", "application/json")
			res.end(
				JSON.stringify({
					id: "fake-1",
					object: "chat.completion",
					created: 0,
					model: "validator-model",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				}),
			)
		})
	})
	servers.push(server)
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address()
			if (typeof addr !== "object" || !addr) throw new Error("fake LLM: failed to bind")
			resolve({ url: `http://127.0.0.1:${addr.port}/v1`, requests })
		})
	})
}

// ---------------------------------------------------------------------------
// WorkflowStep contract
// ---------------------------------------------------------------------------

describe("WorkflowStep boundary (the pack author contract)", () => {
	interface WriteFileInput {
		relativePath: string
		content: string
	}
	interface WriteFileOutput {
		absolutePath: string
	}
	interface WriteFileCompensation {
		createdFile: string
	}

	const writeFileStep: WorkflowStep<WriteFileInput, WriteFileOutput, WriteFileCompensation> = {
		name: "write-file",
		role: AgentRole.WORKER,
		async execute(input, state): Promise<StepResponse<WriteFileOutput, WriteFileCompensation>> {
			if (!input.relativePath) {
				return {
					success: false,
					output: { absolutePath: "" },
					compensationData: { createdFile: "" },
					error: "relativePath is required",
				}
			}
			const absolutePath = join(state.targetDirectory, input.relativePath)
			writeFileSync(absolutePath, input.content, "utf-8")
			return { success: true, output: { absolutePath }, compensationData: { createdFile: absolutePath } }
		},
		async compensate(data): Promise<void> {
			rmSync(data.createdFile, { force: true })
		},
	}

	it("execute receives input and state, writes the file, and reports success with compensation data", async () => {
		const dir = makeTempDir("baka-sdk-step-")
		const result = await writeFileStep.execute({ relativePath: "out.txt", content: "hello" }, makeState(dir))

		expect(result.success).toBe(true)
		expect(result.error).toBeUndefined()
		expect(readFileSync(result.output.absolutePath, "utf-8")).toBe("hello")
		expect(result.compensationData.createdFile).toBe(result.output.absolutePath)
	})

	it("compensate receives the execute-produced compensation data and undoes the write", async () => {
		const dir = makeTempDir("baka-sdk-step-comp-")
		const result = await writeFileStep.execute({ relativePath: "out.txt", content: "hello" }, makeState(dir))
		expect(result.success).toBe(true)

		await writeFileStep.compensate(result.compensationData, makeState(dir))
		expect(existsSync(result.output.absolutePath)).toBe(false)
	})

	it("an invalid input returns success:false with an honest error (no throw, no partial write)", async () => {
		const dir = makeTempDir("baka-sdk-step-invalid-")
		const result = await writeFileStep.execute({ relativePath: "", content: "hello" }, makeState(dir))

		expect(result.success).toBe(false)
		expect(result.error).toContain("relativePath")
		expect(existsSync(join(dir, "out.txt"))).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// callLLMAsValidator boundary
// ---------------------------------------------------------------------------

const CoherenceSchema = z.object({ coherent: z.boolean(), issues: z.array(z.string()) })

describe("callLLMAsValidator", () => {
	it("loads the validator role, posts a schema-constrained request, and returns the parsed content", async () => {
		const home = useFakeHome("baka-sdk-validator-home-")
		const llm = await startFakeLLM({ coherent: true, issues: [] })
		seedValidatorRole(home, llm.url)

		const result = await callLLMAsValidator({
			cwd: "/tmp",
			system: "You assess spec coherence.",
			prompt: "Is this constitution coherent?",
			responseSchema: CoherenceSchema,
		})

		expect(result).toEqual({ coherent: true, issues: [] })

		expect(llm.requests.length).toBe(1)
		const req = llm.requests[0]
		expect(req.path).toBe("/v1/chat/completions")
		expect(req.authorization).toBe("Bearer test-validator-key")
		expect(req.body.model).toBe("validator-model")
		expect(req.body.temperature).toBe(0)
		const messages = req.body.messages as Array<{ role: string; content: string }>
		expect(messages[0]).toEqual({ role: "system", content: "You assess spec coherence." })
		expect(messages[1]).toEqual({ role: "user", content: "Is this constitution coherent?" })
		const responseFormat = req.body.response_format as { type: string; json_schema?: { schema?: unknown } }
		expect(responseFormat.type).toBe("json_schema")
		expect(responseFormat.json_schema?.schema).toBeDefined()
	})

	it("fails honestly with code BAKA_CONFIG_MISSING when no validator role is configured", async () => {
		useFakeHome("baka-sdk-validator-missing-")

		let caught: (Error & { code?: string }) | undefined
		try {
			await callLLMAsValidator({ cwd: "/tmp", prompt: "anything", responseSchema: CoherenceSchema })
		} catch (err) {
			caught = err as Error & { code?: string }
		}
		expect(caught, "expected callLLMAsValidator to throw without a validator role").toBeDefined()
		expect(caught?.code).toBe("BAKA_CONFIG_MISSING")
		expect(caught?.message).toContain("validator role not configured")
	})

	it("never falls back to the worker role when only the worker is configured", async () => {
		const home = useFakeHome("baka-sdk-worker-only-home-")
		const dir = join(home, ".baka")
		mkdirSync(dir, { recursive: true })
		writeFileSync(
			join(dir, "config.json"),
			JSON.stringify({
				worker: {
					baseUrl: "http://127.0.0.1:1/v1",
					model: "worker-model",
					apiKey: "k",
					temperature: 0,
					maxTokens: 1,
					timeoutMs: 1,
				},
			}),
		)

		let caught: (Error & { code?: string }) | undefined
		try {
			await callLLMAsValidator({ cwd: "/tmp", prompt: "anything", responseSchema: CoherenceSchema })
		} catch (err) {
			caught = err as Error & { code?: string }
		}
		expect(caught, "expected callLLMAsValidator to throw when only the worker role exists").toBeDefined()
		expect(caught?.code).toBe("BAKA_CONFIG_MISSING")
		expect(caught?.message).toContain("validator")
	})

	it("rejects LLM output that cannot satisfy the schema after the provider's repair attempt", async () => {
		const home = useFakeHome("baka-sdk-validator-bad-output-")
		// The fake always returns the same non-conforming payload, so the
		// provider's single repair attempt also fails schema validation.
		const llm = await startFakeLLM("this is not json at all")
		seedValidatorRole(home, llm.url)

		let caught: Error | undefined
		try {
			await callLLMAsValidator({ cwd: "/tmp", prompt: "assess", responseSchema: CoherenceSchema })
		} catch (err) {
			caught = err as Error
		}
		expect(caught, "expected callLLMAsValidator to reject non-conforming LLM output").toBeDefined()
		expect(llm.requests.length).toBeGreaterThanOrEqual(2)
	})
})
