import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { OpenAICompatibleProvider } from "./openai-compatible"

const originalFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = originalFetch
	vi.restoreAllMocks()
})

function mockFetchOnce(body: unknown, init?: { status?: number; statusText?: string }): ReturnType<typeof vi.fn> {
	const fn = vi.fn().mockResolvedValue({
		ok: (init?.status ?? 200) < 400,
		status: init?.status ?? 200,
		statusText: init?.statusText ?? "OK",
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response)
	globalThis.fetch = fn as unknown as typeof fetch
	return fn
}

const baseConfig = {
	baseUrl: "http://localhost:8080",
	apiKey: "sk-test",
	model: "test-model",
	temperature: 0,
	maxTokens: 1024,
	timeoutMs: 5000,
	providerOptions: {},
}

describe("OpenAICompatibleProvider", () => {
	it("throws if baseUrl is missing", () => {
		const p = new OpenAICompatibleProvider({ ...baseConfig, baseUrl: "" })
		expect(() => p.validateConfig()).toThrow(/baseUrl/)
	})

	it("throws if model is missing", () => {
		const p = new OpenAICompatibleProvider({ ...baseConfig, model: "" })
		expect(() => p.validateConfig()).toThrow(/model/)
	})

	it("posts to /chat/completions and parses the response", async () => {
		const fetch = mockFetchOnce({
			choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
			usage: { prompt_tokens: 10, completion_tokens: 5 },
		})
		const p = new OpenAICompatibleProvider(baseConfig)
		const schema = z.object({ ok: z.boolean() })
		const result = await p.chat<{ ok: boolean }>({
			model: "",
			messages: [{ role: "user", content: "hi" }],
			responseSchema: schema,
		})
		expect(result.content).toEqual({ ok: true })
		expect(result.usage.promptTokens).toBe(10)
		expect(fetch).toHaveBeenCalledOnce()
		const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
		expect(url).toBe("http://localhost:8080/chat/completions")
		const body = JSON.parse(init.body as string) as Record<string, unknown>
		expect(body.model).toBe("test-model")
		expect(body.stream).toBe(false)
		expect(body.response_format).toBeDefined()
	})

	it("sends the configured seed in the request body", async () => {
		const fetch = mockFetchOnce({
			choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
			usage: { prompt_tokens: 10, completion_tokens: 5 },
		})
		const p = new OpenAICompatibleProvider({ ...baseConfig, seed: 42 })
		const result = await p.chat<{ ok: boolean }>({
			model: "",
			messages: [{ role: "user", content: "hi" }],
			responseSchema: z.object({ ok: z.boolean() }),
		})
		expect(result.content).toEqual({ ok: true })
		const [, init] = fetch.mock.calls[0] as [string, RequestInit]
		const body = JSON.parse(init.body as string) as Record<string, unknown>
		expect(body.seed).toBe(42)
	})

	it("omits seed from the request body when not configured", async () => {
		const fetch = mockFetchOnce({
			choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
			usage: { prompt_tokens: 10, completion_tokens: 5 },
		})
		const p = new OpenAICompatibleProvider(baseConfig)
		await p.chat<{ ok: boolean }>({
			model: "",
			messages: [{ role: "user", content: "hi" }],
			responseSchema: z.object({ ok: z.boolean() }),
		})
		const [, init] = fetch.mock.calls[0] as [string, RequestInit]
		const body = JSON.parse(init.body as string) as Record<string, unknown>
		expect("seed" in body).toBe(false)
	})

	it("repairs malformed JSON via a follow-up call", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					choices: [{ message: { content: "not valid json" } }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				}),
				text: async () => "",
			} as unknown as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				}),
				text: async () => "",
			} as unknown as Response)
		globalThis.fetch = fetch as unknown as typeof fetch

		const p = new OpenAICompatibleProvider(baseConfig)
		const schema = z.object({ ok: z.boolean() })
		const result = await p.chat<{ ok: boolean }>({
			model: "",
			messages: [{ role: "user", content: "hi" }],
			responseSchema: schema,
		})
		expect(result.content).toEqual({ ok: true })
		expect(fetch).toHaveBeenCalledTimes(2)
	})

	it("forwards chat_template_kwargs and string maxLength into the JSON schema", async () => {
		const fetch = mockFetchOnce({
			choices: [{ message: { content: JSON.stringify({ value: "ok" }) } }],
			usage: { prompt_tokens: 1, completion_tokens: 1 },
		})
		const p = new OpenAICompatibleProvider(baseConfig)
		await p.chat({
			model: "",
			messages: [{ role: "user", content: "hi" }],
			responseSchema: z.object({ value: z.string().min(1).max(40) }),
			providerOptions: { chat_template_kwargs: { enable_thinking: false } },
		})
		const [, init] = fetch.mock.calls[0] as [string, RequestInit]
		const body = JSON.parse(init.body as string) as {
			chat_template_kwargs?: { enable_thinking?: boolean }
			response_format?: { json_schema?: { schema?: { properties?: { value?: { maxLength?: number } } } } }
		}
		expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
		expect(body.response_format?.json_schema?.schema?.properties?.value?.maxLength).toBe(40)
	})

	it("retries empty content with thinking disabled", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					choices: [{ message: { content: "", reasoning_content: "thinking..." } }],
					usage: { prompt_tokens: 1, completion_tokens: 128 },
				}),
				text: async () => "",
			} as unknown as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
					usage: { prompt_tokens: 1, completion_tokens: 8 },
				}),
				text: async () => "",
			} as unknown as Response)
		globalThis.fetch = fetch as unknown as typeof fetch
		const p = new OpenAICompatibleProvider(baseConfig)
		const result = await p.chat<{ ok: boolean }>({
			model: "",
			messages: [{ role: "user", content: "hi" }],
			responseSchema: z.object({ ok: z.boolean() }),
		})
		expect(result.content).toEqual({ ok: true })
		expect(fetch).toHaveBeenCalledTimes(2)
		const [, retryInit] = fetch.mock.calls[1] as [string, RequestInit]
		const retryBody = JSON.parse(retryInit.body as string) as { chat_template_kwargs?: { enable_thinking?: boolean } }
		expect(retryBody.chat_template_kwargs).toEqual({ enable_thinking: false })
	})

	it("throws on 5xx upstream errors", async () => {
		mockFetchOnce({ error: "boom" }, { status: 500, statusText: "Internal Server Error" })
		const p = new OpenAICompatibleProvider(baseConfig)
		await expect(
			p.chat({
				model: "",
				messages: [{ role: "user", content: "hi" }],
				responseSchema: z.object({ ok: z.boolean() }),
			}),
		).rejects.toThrow(/500/)
	})
})
