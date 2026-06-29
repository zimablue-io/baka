import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ModuleRegistry } from "./registry.js"

const cleanup: string[] = []
afterEach(() => {
	for (const d of cleanup.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	}
})

function makeProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "baka-registry-"))
	cleanup.push(dir)
	mkdirSync(join(dir, "modules", "mod-a"), { recursive: true })
	mkdirSync(join(dir, "modules", "mod-b"), { recursive: true })
	mkdirSync(join(dir, "modules", "mod-a", "do-thing"), { recursive: true })
	mkdirSync(join(dir, "modules", "mod-b", "act"), { recursive: true })
	writeFileSync(
		join(dir, "modules", "mod-a", "manifest.ts"),
		`import type { ModuleManifest } from "@repo/protocol"
export const Manifest: ModuleManifest = {
	name: "mod-a",
	version: "0.1.0",
	description: "A",
	dependencies: [],
	conflictsWith: [],
	actions: [{ id: "do-thing", description: "Do the thing", params: [], requiresReasoning: false, filePatterns: [], validators: [] }],
	moduleValidators: [],
}
`,
	)
	writeFileSync(
		join(dir, "modules", "mod-b", "manifest.ts"),
		`import type { ModuleManifest } from "@repo/protocol"
export const Manifest: ModuleManifest = {
	name: "mod-b",
	version: "0.1.0",
	description: "B",
	dependencies: ["mod-a"],
	conflictsWith: [],
	actions: [{ id: "act", description: "Act", params: [], requiresReasoning: false, filePatterns: [], validators: [] }],
	moduleValidators: [],
}
`,
	)
	writeFileSync(join(dir, "modules", "mod-a", "do-thing", "action.ts"), "export const doThingAction = {}\n")
	writeFileSync(join(dir, "modules", "mod-b", "act", "action.ts"), "export const actAction = {}\n")
	return dir
}

describe("ModuleRegistry", () => {
	it("discovers valid modules", () => {
		const dir = makeProject()
		const reg = new ModuleRegistry(dir)
		const { modules, diagnostics } = reg.discover()
		expect(modules).toHaveLength(2)
		expect(diagnostics.filter((d) => d.severity === "error")).toEqual([])
	})

	it("flags missing action.ts as an error", () => {
		const dir = mkdtempSync(join(tmpdir(), "baka-registry-"))
		cleanup.push(dir)
		mkdirSync(join(dir, "modules", "broken"), { recursive: true })
		mkdirSync(join(dir, "modules", "broken", "do-thing"), { recursive: true })
		writeFileSync(
			join(dir, "modules", "broken", "manifest.ts"),
			`import type { ModuleManifest } from "@repo/protocol"
export const Manifest: ModuleManifest = {
	name: "broken", version: "0.1.0", description: "", dependencies: [], conflictsWith: [],
	actions: [{ id: "do-thing", description: "X", params: [], requiresReasoning: false, filePatterns: [], validators: [] }],
	moduleValidators: [],
}
`,
		)
		const reg = new ModuleRegistry(dir)
		const { diagnostics } = reg.discover()
		expect(diagnostics.some((d) => d.severity === "error" && d.rule === "action-missing")).toBe(true)
	})

	it("returns modules in dependency order", () => {
		const dir = makeProject()
		const reg = new ModuleRegistry(dir)
		reg.discover()
		const order = reg.resolveOrder().map((m) => m.name)
		expect(order.indexOf("mod-a")).toBeLessThan(order.indexOf("mod-b"))
	})

	it("throws on missing dependency", () => {
		const dir = mkdtempSync(join(tmpdir(), "baka-registry-"))
		cleanup.push(dir)
		mkdirSync(join(dir, "modules", "lone"), { recursive: true })
		mkdirSync(join(dir, "modules", "lone", "act"), { recursive: true })
		writeFileSync(
			join(dir, "modules", "lone", "manifest.ts"),
			`import type { ModuleManifest } from "@repo/protocol"
export const Manifest: ModuleManifest = {
	name: "lone", version: "0.1.0", description: "", dependencies: ["ghost"], conflictsWith: [],
	actions: [{ id: "act", description: "X", params: [], requiresReasoning: false, filePatterns: [], validators: [] }],
	moduleValidators: [],
}
`,
		)
		writeFileSync(join(dir, "modules", "lone", "act", "action.ts"), "export const actAction = {}\n")
		const reg = new ModuleRegistry(dir)
		reg.discover()
		expect(() => reg.resolveOrder()).toThrow(/ghost/)
	})
})
