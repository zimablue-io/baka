import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

// This file registers our custom provider with the PI platform.
// The actual LLM configuration (baseUrl, modelId) should be injected
// via environment variables or a separate config file,
// NOT hardcoded here.

export default function (pi: ExtensionAPI) {
	pi.registerProvider("pi-engine-provider", {
		name: "PI Engine Provider",
		// Configuration is injected via ENV variables for provider agnosticism
		baseUrl: process.env.PI_ENGINE_BASE_URL || "http://localhost:11434",
		apiKey: process.env.PI_ENGINE_API_KEY || "none",
		api: "openai-completions",
		models: [
			{
				id: process.env.PI_ENGINE_MODEL_ID || "gemma2",
				name: "Engine Model",
				reasoning: true, // Required for planning/orchestrator roles
				input: ["text"],
				contextWindow: 32768,
				maxTokens: 8192,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
			},
		],
	})
}
