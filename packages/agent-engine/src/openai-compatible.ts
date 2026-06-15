import { z } from "zod"
import {
	BAKA_EXIT_CODE,
	type LLMMessage,
	type LLMProvider,
	type LLMRequest,
	type LLMResponse,
	type ResolvedLLMConfig,
} from "@repo/protocol"

// ---------------------------------------------------------------------------
// OpenAI-compatible chat completions provider
//
// Covers llama.cpp's server, vLLM, ollama's /v1 endpoint, LM Studio, etc.
// The wire format is the OpenAI /v1/chat/completions schema; llama.cpp and
// its peers speak the same shape. The `response_format: json_schema` field
// is sent when the schema is an object so constrained decoding kicks in.
// ---------------------------------------------------------------------------

export class OpenAICompatibleProvider implements LLMProvider {
	readonly name = "openai-compatible"
	private readonly config: ResolvedLLMConfig

	constructor(config: ResolvedLLMConfig) {
		this.config = config
	}

	validateConfig(): void {
		if (!this.config.baseUrl) {
			throw makeError(BAKA_EXIT_CODE.PROVIDER_ERROR, "openai-compatible: baseUrl is required (BAKA_LLM_BASE_URL)")
		}
		if (!this.config.model) {
			throw makeError(BAKA_EXIT_CODE.PROVIDER_ERROR, "openai-compatible: model is required (BAKA_LLM_MODEL)")
		}
	}

	async chat<T = unknown>(request: LLMRequest): Promise<LLMResponse<T>> {
		this.validateConfig()

		const url = joinUrl(this.config.baseUrl, "/chat/completions")
		const body: Record<string, unknown> = {
			model: request.model || this.config.model,
			messages: request.messages.map(toWireMessage),
			temperature: request.temperature ?? this.config.temperature,
			max_tokens: request.maxTokens ?? this.config.maxTokens,
			stream: false,
		}

		// Constrained decoding: only attach json_schema when the schema is an object.
		const schema = request.responseSchema
		if (schema && schema instanceof z.ZodType) {
			body.response_format = {
				type: "json_schema",
				json_schema: {
					name: "baka_response",
					strict: true,
					schema: toJsonSchema(schema),
				},
			}
		}

		const response = await fetchWithTimeout(url, body, this.config, request)
		const text = response.choices?.[0]?.message?.content
		if (typeof text !== "string") {
			throw makeError(BAKA_EXIT_CODE.PROVIDER_ERROR, `openai-compatible: empty or non-string content in response`)
		}

		// Parse and validate. If parsing fails, retry once with a repair message.
		let parsed: unknown
		try {
			parsed = JSON.parse(text)
		} catch (err) {
			const repaired = await tryRepair(url, body, this.config, request, text, err)
			parsed = repaired
		}

		const validation = schema.safeParse(parsed)
		if (!validation.success) {
			const repaired = await tryRepair(url, body, this.config, request, text, validation.error)
			const retry = schema.safeParse(repaired)
			if (!retry.success) {
				throw makeError(
					BAKA_EXIT_CODE.PROVIDER_ERROR,
					`openai-compatible: response did not match schema after one repair attempt: ${retry.error.message}`,
				)
			}
			return {
				content: retry.data as T,
				usage: toUsage(response.usage),
				raw: response,
			}
		}

		return {
			content: validation.data as T,
			usage: toUsage(response.usage),
			raw: response,
		}
	}
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface WireResponse {
	choices?: Array<{ message?: { content?: unknown } }>
	usage?: { prompt_tokens?: number; completion_tokens?: number }
}

async function fetchWithTimeout(
	url: string,
	body: Record<string, unknown>,
	config: ResolvedLLMConfig,
	request: LLMRequest,
): Promise<WireResponse> {
	const controller = new AbortController()
	const timeout = request.timeoutMs ?? config.timeoutMs ?? 120_000
	const timer = setTimeout(() => controller.abort(), timeout)

	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: config.apiKey ? `Bearer ${config.apiKey}` : "",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		})
		if (!res.ok) {
			const text = await res.text().catch(() => "")
			throw makeError(
				BAKA_EXIT_CODE.PROVIDER_ERROR,
				`openai-compatible: ${res.status} ${res.statusText} from ${url}: ${text.slice(0, 500)}`,
			)
		}
		return (await res.json()) as WireResponse
	} catch (err) {
		if ((err as Error).name === "AbortError") {
			throw makeError(BAKA_EXIT_CODE.PROVIDER_ERROR, `openai-compatible: request to ${url} timed out after ${timeout}ms`)
		}
		throw err
	} finally {
		clearTimeout(timer)
	}
}

async function tryRepair(
	url: string,
	_body: Record<string, unknown>,
	config: ResolvedLLMConfig,
	request: LLMRequest,
	previousText: string,
	previousError: unknown,
): Promise<unknown> {
	const message = previousError instanceof Error ? previousError.message : String(previousError)
	const repairMessages: LLMMessage[] = [
		...request.messages,
		{ role: "assistant", content: previousText },
		{
			role: "user",
			content:
				`The previous response did not match the required JSON schema. ` +
				`Error: ${message}\n` +
				`Respond with a single valid JSON object that satisfies the schema. No prose, no markdown fences.`,
		},
	]
	const repairBody: Record<string, unknown> = {
		..._body,
		messages: repairMessages.map(toWireMessage),
	}
	const res = await fetchWithTimeout(url, repairBody, config, request)
	const text = res.choices?.[0]?.message?.content
	if (typeof text !== "string") {
		throw makeError(BAKA_EXIT_CODE.PROVIDER_ERROR, "openai-compatible: repair attempt returned empty content")
	}
	try {
		return JSON.parse(text)
	} catch (err) {
		throw makeError(
			BAKA_EXIT_CODE.PROVIDER_ERROR,
			`openai-compatible: repair attempt did not return valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
}

// ---------------------------------------------------------------------------
// Wire format translation
// ---------------------------------------------------------------------------

function toWireMessage(m: LLMMessage): { role: string; content: string; name?: string } {
	const out: { role: string; content: string; name?: string } = { role: m.role, content: m.content }
	if (m.name) out.name = m.name
	return out
}

function joinUrl(base: string, path: string): string {
	return base.replace(/\/$/, "") + path
}

function makeError(code: number, message: string): Error & { code: number; bakaExit: number } {
	const err = new Error(message) as Error & { code: number; bakaExit: number }
	err.bakaExit = code
	return err
}

// ---------------------------------------------------------------------------
// Zod -> JSON Schema (minimal). We only need objects; arrays of objects and
// enums are handled. Anything zod can describe as JSON Schema works here.
// ---------------------------------------------------------------------------

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
	if (schema instanceof z.ZodObject) {
		const shape = schema.shape as Record<string, z.ZodType>
		const properties: Record<string, unknown> = {}
		const required: string[] = []
		for (const [k, v] of Object.entries(shape)) {
			properties[k] = toJsonSchema(v)
			if (!(v instanceof z.ZodOptional)) required.push(k)
		}
		return { type: "object", properties, required, additionalProperties: false }
	}
	if (schema instanceof z.ZodString) return { type: "string" }
	if (schema instanceof z.ZodNumber) return { type: "number" }
	if (schema instanceof z.ZodBoolean) return { type: "boolean" }
	if (schema instanceof z.ZodArray) return { type: "array", items: toJsonSchema(schema.element as z.ZodType) }
	if (schema instanceof z.ZodEnum) return { type: "string", enum: schema.options }
	if (schema instanceof z.ZodOptional) return toJsonSchema(schema.unwrap() as z.ZodType)
	if (schema instanceof z.ZodRecord) {
		// z.ZodRecord's valueSchema is exposed as .valueSchema in zod v3
		const valueSchema = (schema as unknown as { valueSchema?: z.ZodType }).valueSchema
		const fallback = z.any()
		return { type: "object", additionalProperties: toJsonSchema(valueSchema ?? fallback) }
	}
	if (schema instanceof z.ZodAny) return {}
	return { type: "object" }
}

function toUsage(wire: { prompt_tokens?: number; completion_tokens?: number } | undefined): import("@repo/protocol").LLMUsage {
	return {
		promptTokens: wire?.prompt_tokens ?? 0,
		completionTokens: wire?.completion_tokens ?? 0,
	}
}
