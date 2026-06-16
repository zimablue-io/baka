import { describe, expect, test } from "vitest"
import {
	renderActionStubSource,
	renderManifestSource,
	renderPreferencesFile,
	renderTemplateStubSource,
	renderValidatorStubSource,
} from "./module-design"

describe("module-design renderers", () => {
	test("renderManifestSource produces a baka-sdk-importing manifest", () => {
		const src = renderManifestSource(
			"test-mod",
			"a test module",
			[],
			[
				{
					id: "scaffold",
					description: "Scaffold a project",
					params: [
						{ name: "name", type: "string", required: true, description: "project name" },
						{ name: "moduleType", type: "enum", required: true, description: "type", enumValues: ["esm", "cjs"] },
					],
					requiresReasoning: false,
					compensatesWith: null,
					validators: [{ id: "hasPackageJson", purpose: "must have a package.json" }],
				},
			],
		)
		expect(src).toContain('import type { ModuleManifest } from "baka-sdk"')
		expect(src).toContain('"name": "test-mod"')
		expect(src).toContain('"scaffold"')
		expect(src).toContain('"enumValues": [')
		// Parse it back as JSON to ensure shape is valid.
		const match = src.match(/export const Manifest: ModuleManifest = (\{[\s\S]*\})/)
		expect(match).toBeTruthy()
		const parsed = JSON.parse((match as RegExpMatchArray)[1] as string) as {
			name: string
			actions: Array<{ id: string }>
		}
		expect(parsed.name).toBe("test-mod")
		expect(parsed.actions[0]?.id).toBe("scaffold")
	})

	test("renderActionStubSource uses baka-sdk types and includes the param interface", () => {
		const src = renderActionStubSource({
			id: "scaffold",
			description: "Scaffold a TS project",
			params: [{ name: "name", type: "string", required: true, description: "project name" }],
			requiresReasoning: false,
			compensatesWith: null,
		})
		expect(src).toContain('import type { ActionFn, CompensationFn } from "baka-sdk"')
		expect(src).toContain("export interface ScaffoldInput")
		expect(src).toContain("name: string")
		expect(src).toContain("export const scaffold: ActionFn<ScaffoldInput")
		expect(src).toContain("export const compensate: CompensationFn<ScaffoldCompensationData>")
	})

	test("renderValidatorStubSource returns a typed stub", () => {
		const src = renderValidatorStubSource("noConsoleLog", "production code must not call console.log")
		expect(src).toContain('import type { ActionValidatorFn } from "baka-sdk"')
		expect(src).toContain("production code must not call console.log")
		expect(src).toContain("export const validator: ActionValidatorFn")
	})

	test("renderTemplateStubSource inlines the outline as a comment", () => {
		const src = renderTemplateStubSource("scaffold", "intro", "Welcome to {{name}}")
		expect(src).toContain("Action: scaffold")
		expect(src).toContain("Template: intro")
		expect(src).toContain("Welcome to {{name}}")
	})

	test("renderPreferencesFile wraps the body in YAML frontmatter", () => {
		const src = renderPreferencesFile("test-mod", "## Domain\nTest\n## Conventions\n- one")
		expect(src).toMatch(/^---\nmodule: test-mod\ngeneratedAt: \d{4}-\d{2}-\d{2}\n---\n/)
		expect(src).toContain("## Domain")
		expect(src).toContain("## Conventions")
	})

	test("renderManifestSource compiles to a valid Zod-schema-parseable shape", async () => {
		// Import the schema from the protocol package
		const { ModuleManifestSchema } = await import("@repo/protocol")
		const src = renderManifestSource(
			"valid-mod",
			"a module that should parse",
			[],
			[
				{
					id: "do-thing",
					description: "does the thing",
					params: [
						{ name: "input", type: "string", required: true, description: "the input" },
						{ name: "count", type: "number", required: false, description: "times to run" },
						{ name: "verbose", type: "boolean", required: false, description: "log loudly" },
					],
					requiresReasoning: false,
					compensatesWith: null,
					validators: [],
				},
			],
		)
		// Extract the JSON object and validate it against the schema
		const match = src.match(/export const Manifest: ModuleManifest = (\{[\s\S]*\})/)
		expect(match).toBeTruthy()
		const obj = JSON.parse((match as RegExpMatchArray)[1] as string)
		const parsed = ModuleManifestSchema.safeParse(obj)
		expect(parsed.success).toBe(true)
	})
})
