import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { LLMProvider, LLMRequest } from "../src/index.js"

const cleanups: string[] = []

/** Remove every temp dir created by `tempDir` since the last call. */
export function cleanupTempDirs(): void {
	for (const dir of cleanups.splice(0)) {
		rmSync(dir, { recursive: true, force: true })
	}
}

export function tempDir(prefix = "baka-core-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	cleanups.push(dir)
	return dir
}

interface FixtureParam {
	name: string
	type: string
	required: boolean
	description: string
	[extra: string]: unknown
}

interface FixtureAction {
	id: string
	params?: FixtureParam[]
	/** Template files, keyed by path under `<action>/templates/` (e.g. `hello.md.hbs`). */
	templates?: Record<string, string>
	/** Source of `<action>/action.ts`, when the action has side effects. */
	actionTs?: string
}

interface FixtureModule {
	name: string
	version?: string
	actions: FixtureAction[]
	/** Extra files under the module root, keyed by relative path. */
	files?: Record<string, string>
}

/** Write a module directory under `modulesDir` and return its root. */
export function writeModule(modulesDir: string, mod: FixtureModule): string {
	const root = join(modulesDir, mod.name)
	const manifest = {
		name: mod.name,
		version: mod.version ?? "0.1.0",
		description: `${mod.name} fixture`,
		dependencies: [],
		conflictsWith: [],
		actions: mod.actions.map((a) => ({
			id: a.id,
			description: `${a.id} fixture action`,
			params: a.params ?? [],
			requiresReasoning: false,
			filePatterns: [],
			validators: [],
		})),
		moduleValidators: [],
	}
	write(join(root, "manifest.ts"), `export const Manifest = ${JSON.stringify(manifest, null, 2)}\n`)
	for (const action of mod.actions) {
		for (const [rel, source] of Object.entries(action.templates ?? {})) {
			write(join(root, action.id, "templates", rel), source)
		}
		if (action.actionTs) write(join(root, action.id, "action.ts"), action.actionTs)
	}
	for (const [rel, source] of Object.entries(mod.files ?? {})) write(join(root, rel), source)
	return root
}

function write(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, content, "utf-8")
}

const GREET_PARAMS: FixtureParam[] = [{ name: "name", type: "string", required: true, description: "who" }]

/** One template with a named prose slot: `hello.md` = heading + one filled sentence. */
export const GREET_MODULE: FixtureModule = {
	name: "hello",
	actions: [
		{
			id: "greet",
			params: GREET_PARAMS,
			templates: { "hello.md.hbs": '# {{name}}\n{{#slot "blurb" kind="prose" max=80}}one sentence{{/slot}}\n' },
		},
	],
}

interface FakeProvider extends LLMProvider {
	calls: LLMRequest[]
}

/** A provider that answers every slot with `value` and records each request. */
export function fakeProvider(value: unknown = "A fake greeting."): FakeProvider {
	const calls: LLMRequest[] = []
	return {
		name: "fake",
		calls,
		validateConfig: () => {},
		chat: async <T>(request: LLMRequest) => {
			calls.push(request)
			return { content: { value } as T, usage: { promptTokens: 0, completionTokens: 0 }, raw: null }
		},
	}
}
