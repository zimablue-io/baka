// Decision 33 + decision 13 tests for the role config store and loader.
//
// Decision 33: the config store resolves ${BAKA_HOME:-$HOME/.baka}/config.json.
// Decision 13: a role block missing a required field (baseUrl, model, apiKey)
// fails fast at load with an error naming the role and the exact missing field.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readRoleConfig, userConfigPath, writeRoleConfig } from "./config/store.js"
import { loadLLMConfig, validateLLMConfig } from "./index"

const prevBakaHome = process.env.BAKA_HOME
const prevHome = process.env.HOME
const tempDirs: string[] = []

afterEach(() => {
	if (prevBakaHome === undefined) delete process.env.BAKA_HOME
	else process.env.BAKA_HOME = prevBakaHome
	if (prevHome === undefined) delete process.env.HOME
	else process.env.HOME = prevHome
	for (const d of tempDirs.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	}
})

function mkTemp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix))
	tempDirs.push(d)
	return d
}

function setHomes(): { bakaHome: string; home: string } {
	const bakaHome = mkTemp("baka-engine-bakahome-")
	const home = mkTemp("baka-engine-home-")
	process.env.BAKA_HOME = bakaHome
	process.env.HOME = home
	return { bakaHome, home }
}

describe("config store honors BAKA_HOME (architecture decision 33)", () => {
	it("userConfigPath resolves to $BAKA_HOME/config.json when set", () => {
		const { bakaHome } = setHomes()
		expect(userConfigPath()).toBe(join(bakaHome, "config.json"))
	})

	it("userConfigPath falls back to $HOME/.baka/config.json when BAKA_HOME is unset", () => {
		delete process.env.BAKA_HOME
		const home = mkTemp("baka-engine-fallback-")
		process.env.HOME = home
		expect(userConfigPath()).toBe(join(home, ".baka", "config.json"))
	})

	it("writeRoleConfig + readRoleConfig round-trip through $BAKA_HOME/config.json", () => {
		const { bakaHome, home } = setHomes()
		writeRoleConfig("worker", { baseUrl: "http://x", model: "m", apiKey: "k" })

		expect(existsSync(join(bakaHome, "config.json"))).toBe(true)
		expect(existsSync(join(home, ".baka", "config.json"))).toBe(false)
		expect(readRoleConfig("worker")?.model).toBe("m")
	})

	it("loadLLMConfig reads the role block from $BAKA_HOME/config.json", async () => {
		const { bakaHome } = setHomes()
		mkdirSync(bakaHome, { recursive: true })
		writeFileSync(
			join(bakaHome, "config.json"),
			JSON.stringify({ worker: { baseUrl: "http://baka-home.example/v1", model: "bh-model", apiKey: "bh-key" } }),
		)

		const config = await loadLLMConfig({ role: "worker", cwd: "/tmp" })
		expect(config.baseUrl).toBe("http://baka-home.example/v1")
		expect(config.model).toBe("bh-model")
		expect(config.apiKey).toBe("bh-key")
	})
})

describe("loadLLMConfig fails fast on missing apiKey (architecture decision 13)", () => {
	function seedWorker(home: string, block: Record<string, unknown>): void {
		delete process.env.BAKA_HOME
		process.env.HOME = home
		const dir = join(home, ".baka")
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, "config.json"), JSON.stringify({ worker: block }))
	}

	it("throws naming the role and the apiKey field when apiKey is absent", async () => {
		const home = mkTemp("baka-engine-noapikey-")
		seedWorker(home, { baseUrl: "http://x", model: "m" })

		let caught: (Error & { code?: string }) | undefined
		try {
			await loadLLMConfig({ role: "worker", cwd: "/tmp" })
		} catch (err) {
			caught = err as Error & { code?: string }
		}
		expect(caught, "expected loadLLMConfig to throw on a missing apiKey").toBeDefined()
		expect(caught?.code).toBe("BAKA_CONFIG_MISSING")
		expect(caught?.message).toContain("worker")
		expect(caught?.message).toContain("apiKey")
	})

	it("throws naming the apiKey field when apiKey is an empty string", async () => {
		const home = mkTemp("baka-engine-emptyapikey-")
		seedWorker(home, { baseUrl: "http://x", model: "m", apiKey: "" })

		await expect(loadLLMConfig({ role: "worker", cwd: "/tmp" })).rejects.toThrow(/apiKey/)
	})

	it("names every missing required field in one error", async () => {
		const home = mkTemp("baka-engine-allmissing-")
		seedWorker(home, { temperature: 0 })

		await expect(loadLLMConfig({ role: "worker", cwd: "/tmp" })).rejects.toThrow(/baseUrl.*model.*apiKey/s)
	})

	it("an override-supplied apiKey satisfies the requirement", async () => {
		const home = mkTemp("baka-engine-override-apikey-")
		seedWorker(home, { baseUrl: "http://x", model: "m" })

		const config = await loadLLMConfig({ role: "worker", cwd: "/tmp", overrides: { apiKey: "override-key" } })
		expect(config.apiKey).toBe("override-key")
	})
})

describe("validateLLMConfig requires apiKey (architecture decision 13)", () => {
	it("throws when apiKey is empty", () => {
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
		).toThrow(/apiKey/)
	})
})
