import { existsSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { loadLLMConfig, validateLLMConfig } from "./index"

const TEST_HOME = join(homedir(), ".config", "baka-test")

beforeEach(() => {
	// The conf library stores state at the homedir() / projectName path.
	// For tests we mock out the userStore by directly poking the conf file.
	// Each test starts from a clean slate.
	const configFile = join(TEST_HOME, "config.json")
	try {
		if (existsSync(configFile)) rmSync(configFile)
	} catch {
		/* best effort */
	}
})

describe("loadLLMConfig", () => {
	it("returns empty config when nothing is set", async () => {
		// Clear any inherited BAKA_LLM_* env so the precedence chain collapses
		// to defaults. CI often sets these to point at a fixture endpoint.
		const prev = { ...process.env }
		for (const k of Object.keys(process.env)) {
			if (k.startsWith("BAKA_LLM_")) delete process.env[k]
		}
		try {
			const config = await loadLLMConfig({ cwd: "/tmp", skipCredentials: true })
			expect(config.baseUrl).toBe("")
			expect(config.model).toBe("")
		} finally {
			process.env = prev
		}
	})

	it("applies CLI overrides on top of empty config", async () => {
		const config = await loadLLMConfig({
			cwd: "/tmp",
			skipCredentials: true,
			overrides: { baseUrl: "http://x:1", model: "m", apiKey: "k" },
		})
		expect(config.baseUrl).toBe("http://x:1")
		expect(config.model).toBe("m")
		expect(config.apiKey).toBe("k")
	})

	it("env vars beat overrides when overrides are empty", async () => {
		const prev = { ...process.env }
		for (const k of Object.keys(process.env)) {
			if (k.startsWith("BAKA_LLM_")) delete process.env[k]
		}
		process.env.BAKA_LLM_BASE_URL = "http://env:1"
		try {
			const config = await loadLLMConfig({ cwd: "/tmp", skipCredentials: true })
			expect(config.baseUrl).toBe("http://env:1")
		} finally {
			process.env = prev
		}
	})

	it("providerOptions.name carries the active provider name", async () => {
		const config = await loadLLMConfig({ cwd: "/tmp", skipCredentials: true, providerName: "llama-local" })
		expect(config.providerOptions.name).toBe("llama-local")
	})
})

describe("validateLLMConfig", () => {
	it("throws on missing baseUrl and model", () => {
		expect(() =>
			validateLLMConfig({
				baseUrl: "",
				apiKey: "",
				model: "",
				temperature: 0,
				maxTokens: 1,
				timeoutMs: 1,
				providerOptions: {},
			}),
		).toThrow(/missing LLM config/)
	})

	it("passes on a complete config", () => {
		expect(() =>
			validateLLMConfig({
				baseUrl: "http://x",
				apiKey: "",
				model: "m",
				temperature: 0,
				maxTokens: 1,
				timeoutMs: 1,
				providerOptions: {},
			}),
		).not.toThrow()
	})
})
