// ---------------------------------------------------------------------------
// Unit tests for action-loader.ts.
//
// These tests pin the export resolution order for action ids, including
// hyphenated ids that resolve through their camelCase export names.
// ---------------------------------------------------------------------------

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModuleManifest } from "@repo/protocol"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadAction } from "./action-loader.js"

let tempDir: string

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "baka-loader-"))
})

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true })
})

function manifestFixture(actionId: string): ModuleManifest {
	return {
		name: "fixture",
		version: "0.0.1",
		description: "test fixture",
		dependencies: [],
		conflictsWith: [],
		actions: [
			{
				id: actionId,
				description: "fixture action",
				requiresReasoning: false,
				filePatterns: [],
				validators: [],
				params: [],
			},
		],
		moduleValidators: [],
	}
}

function writeActionFile(actionId: string, source: string): void {
	const actionDir = join(tempDir, actionId)
	mkdirSync(actionDir, { recursive: true })
	writeFileSync(join(actionDir, "action.ts"), source, "utf-8")
}

describe("loadAction", () => {
	it("resolves a hyphenated action id by its camelCase export", async () => {
		const manifest = manifestFixture("add-script")
		writeActionFile(
			"add-script",
			`export const addScriptAction = {
				execute: async () => ({ success: true, output: "add-script-ok" }),
				compensate: async () => {},
			}`,
		)

		const loaded = loadAction<unknown, string, unknown>(tempDir, tempDir, manifest, "add-script")
		expect(loaded.actionId).toBe("add-script")

		const result = await loaded.step.execute({}, {} as never, {} as never)
		expect(result.success).toBe(true)
		expect(result.output).toBe("add-script-ok")
	})

	it("prefers camelCase(id)Action over the default export", async () => {
		const manifest = manifestFixture("pick")
		writeActionFile(
			"pick",
			`export const pickAction = {
				execute: async () => ({ success: true, output: "pickAction" }),
				compensate: async () => {},
			}
			export default {
				execute: async () => ({ success: true, output: "default" }),
				compensate: async () => {},
			}`,
		)

		const loaded = loadAction<unknown, string, unknown>(tempDir, tempDir, manifest, "pick")
		const result = await loaded.step.execute({}, {} as never, {} as never)
		expect(result.output).toBe("pickAction")
	})

	it("still resolves non-hyphenated ids through the legacy idAction shape", async () => {
		const manifest = manifestFixture("scaffold")
		writeActionFile(
			"scaffold",
			`export const scaffoldAction = {
				execute: async () => ({ success: true, output: "scaffoldAction" }),
				compensate: async () => {},
			}`,
		)

		const loaded = loadAction<unknown, string, unknown>(tempDir, tempDir, manifest, "scaffold")
		const result = await loaded.step.execute({}, {} as never, {} as never)
		expect(result.output).toBe("scaffoldAction")
	})

	it("throws an honest error when no candidate export resolves", () => {
		const manifest = manifestFixture("bad-action")
		writeActionFile(
			"bad-action",
			`export const somethingElse = {
				execute: async () => ({ success: true }),
				compensate: async () => {},
			}`,
		)

		expect(() => loadAction(tempDir, tempDir, manifest, "bad-action")).toThrow(/must export/)
	})
})
