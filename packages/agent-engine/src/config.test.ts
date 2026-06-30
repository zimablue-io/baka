import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadLLMConfig, validateLLMConfig } from "./index"

const prevHome = process.env.HOME
const tempHomes: string[] = []

afterEach(() => {
	process.env.HOME = prevHome
	for (const d of tempHomes.splice(0)) {
		try {
			import("node:fs").then((fs) => fs.rmSync(d, { recursive: true, force: true }))
		} catch {
			/* best effort */
		}
	}
})

describe("loadLLMConfig", () => {
	it("returns empty config when nothing is set", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "baka-empty-cfg-"))
		tempHomes.push(fakeHome)
		process.env.HOME = fakeHome
		const config = await loadLLMConfig({ cwd: "/tmp", skipCredentials: true })
		expect(config.baseUrl).toBe("")
		expect(config.model).toBe("")
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
