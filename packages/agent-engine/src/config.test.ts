import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
			rmSync(d, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	}
})

interface RoleBlock {
	baseUrl: string
	model: string
	apiKey?: string
	temperature?: number
	maxTokens?: number
	timeoutMs?: number
}

function seedRoleConfig(home: string, opts: { worker?: RoleBlock; validator?: RoleBlock } = {}): void {
	const dir = join(home, ".baka")
	mkdirSync(dir, { recursive: true })
	const cfg: Record<string, unknown> = {}
	if (opts.worker) {
		cfg.worker = {
			baseUrl: opts.worker.baseUrl,
			model: opts.worker.model,
			apiKey: opts.worker.apiKey ?? "worker-key",
			temperature: opts.worker.temperature ?? 0,
			maxTokens: opts.worker.maxTokens ?? 8192,
			timeoutMs: opts.worker.timeoutMs ?? 120_000,
		}
	}
	if (opts.validator) {
		cfg.validator = {
			baseUrl: opts.validator.baseUrl,
			model: opts.validator.model,
			apiKey: opts.validator.apiKey ?? "validator-key",
			temperature: opts.validator.temperature ?? 0,
			maxTokens: opts.validator.maxTokens ?? 8192,
			timeoutMs: opts.validator.timeoutMs ?? 120_000,
		}
	}
	writeFileSync(join(dir, "config.json"), JSON.stringify(cfg, null, 2))
}

describe("loadLLMConfig — role-keyed shape", () => {
	it("reads the worker block when role=worker", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "baka-role-worker-"))
		tempHomes.push(fakeHome)
		process.env.HOME = fakeHome
		seedRoleConfig(fakeHome, {
			worker: { baseUrl: "http://worker.example/v1", model: "worker-model" },
			validator: { baseUrl: "http://validator.example/v1", model: "validator-model" },
		})

		const config = await loadLLMConfig({ role: "worker", cwd: "/tmp" })
		expect(config.baseUrl).toBe("http://worker.example/v1")
		expect(config.model).toBe("worker-model")
	})

	it("reads the validator block when role=validator", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "baka-role-validator-"))
		tempHomes.push(fakeHome)
		process.env.HOME = fakeHome
		seedRoleConfig(fakeHome, {
			worker: { baseUrl: "http://worker.example/v1", model: "worker-model" },
			validator: { baseUrl: "http://validator.example/v1", model: "validator-model" },
		})

		const config = await loadLLMConfig({ role: "validator", cwd: "/tmp" })
		expect(config.baseUrl).toBe("http://validator.example/v1")
		expect(config.model).toBe("validator-model")
	})

	it("throws `missing LLM config: worker role not configured` when worker block is absent", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "baka-role-missing-worker-"))
		tempHomes.push(fakeHome)
		process.env.HOME = fakeHome
		seedRoleConfig(fakeHome, {
			validator: { baseUrl: "http://validator.example/v1", model: "validator-model" },
		})

		await expect(loadLLMConfig({ role: "worker", cwd: "/tmp" })).rejects.toThrow(
			/missing LLM config: worker role not configured/,
		)
	})

	it("throws `missing LLM config: validator role not configured` when validator block is absent", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "baka-role-missing-validator-"))
		tempHomes.push(fakeHome)
		process.env.HOME = fakeHome
		seedRoleConfig(fakeHome, {
			worker: { baseUrl: "http://worker.example/v1", model: "worker-model" },
		})

		await expect(loadLLMConfig({ role: "validator", cwd: "/tmp" })).rejects.toThrow(
			/missing LLM config: validator role not configured/,
		)
	})

	it("throws when worker block is missing baseUrl", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "baka-role-worker-no-baseurl-"))
		tempHomes.push(fakeHome)
		process.env.HOME = fakeHome
		const dir = join(fakeHome, ".baka")
		mkdirSync(dir, { recursive: true })
		writeFileSync(
			join(dir, "config.json"),
			JSON.stringify({ worker: { model: "worker-model", apiKey: "k", temperature: 0, maxTokens: 1, timeoutMs: 1 } }),
		)

		await expect(loadLLMConfig({ role: "worker", cwd: "/tmp" })).rejects.toThrow(/baseUrl/)
	})

	it("throws when worker block is missing model", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "baka-role-worker-no-model-"))
		tempHomes.push(fakeHome)
		process.env.HOME = fakeHome
		const dir = join(fakeHome, ".baka")
		mkdirSync(dir, { recursive: true })
		writeFileSync(
			join(dir, "config.json"),
			JSON.stringify({ worker: { baseUrl: "http://x", apiKey: "k", temperature: 0, maxTokens: 1, timeoutMs: 1 } }),
		)

		await expect(loadLLMConfig({ role: "worker", cwd: "/tmp" })).rejects.toThrow(/model/)
	})

	it("applies overrides on top of the worker block", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "baka-role-worker-overrides-"))
		tempHomes.push(fakeHome)
		process.env.HOME = fakeHome
		seedRoleConfig(fakeHome, {
			worker: {
				baseUrl: "http://worker.example/v1",
				model: "worker-model",
				temperature: 0.0,
				maxTokens: 8192,
				timeoutMs: 120_000,
			},
		})

		const config = await loadLLMConfig({
			role: "worker",
			cwd: "/tmp",
			overrides: { temperature: 0.5 },
		})
		expect(config.temperature).toBe(0.5)
		expect(config.baseUrl).toBe("http://worker.example/v1")
	})

	it("reads the apiKey from the role's config block", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "baka-role-apikey-"))
		tempHomes.push(fakeHome)
		process.env.HOME = fakeHome
		seedRoleConfig(fakeHome, {
			worker: { baseUrl: "http://worker.example/v1", model: "worker-model", apiKey: "inline-worker-key" },
		})

		const config = await loadLLMConfig({ role: "worker", cwd: "/tmp" })
		expect(config.apiKey).toBe("inline-worker-key")
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
