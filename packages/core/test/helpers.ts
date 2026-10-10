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

interface FixtureRecipe {
	id: string
	params?: FixtureParam[]
	/** Template files, keyed by path under `<recipe>/templates/` (e.g. `hello.md.hbs`). */
	templates?: Record<string, string>
	/** Source of `<recipe>/recipe.ts`, when the recipe has side effects. */
	recipeTs?: string
	/** The manifest's `supportsDryRun` for this recipe. */
	supportsDryRun?: boolean
	/** Validator ids the recipe declares; write each as `<recipe>/validators/<kebab-id>.ts` via `files`. */
	validators?: string[]
	/** The manifest's `marker` globs for this recipe. */
	marker?: string[]
	/** The manifest's `format` declaration for this recipe. */
	format?: { command: string; args?: string[] }
}

interface FixturePack {
	name: string
	version?: string
	recipes: FixtureRecipe[]
	/** Extra files under the pack root, keyed by relative path. */
	files?: Record<string, string>
	/** Pack-level validator ids; write each as `_shared/validators/<kebab-id>.ts` via `files`. */
	packValidators?: string[]
}

/** Write a pack directory under `packsDir` and return its root. */
export function writePack(packsDir: string, mod: FixturePack): string {
	const root = join(packsDir, mod.name)
	const manifest = {
		name: mod.name,
		version: mod.version ?? "0.1.0",
		description: `${mod.name} fixture`,
		dependencies: [],
		conflictsWith: [],
		recipes: mod.recipes.map((a) => ({
			id: a.id,
			description: `${a.id} fixture recipe`,
			params: a.params ?? [],
			requiresReasoning: false,
			filePatterns: [],
			validators: a.validators ?? [],
			supportsDryRun: a.supportsDryRun ?? false,
			...(a.marker ? { marker: a.marker } : {}),
			...(a.format ? { format: a.format } : {}),
		})),
		packValidators: mod.packValidators ?? [],
	}
	write(join(root, "manifest.ts"), `export const Manifest = ${JSON.stringify(manifest, null, 2)}\n`)
	for (const recipe of mod.recipes) {
		for (const [rel, source] of Object.entries(recipe.templates ?? {})) {
			write(join(root, recipe.id, "templates", rel), source)
		}
		if (recipe.recipeTs) write(join(root, recipe.id, "recipe.ts"), recipe.recipeTs)
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
export const GREET_PACK: FixturePack = {
	name: "hello",
	recipes: [
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
