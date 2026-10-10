import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { DesignSessionState } from "../state"
import { renderPreferencesFile, renderReadmeSource } from "./docs"
import {
	renderManifestSource,
	renderRecipeStubSource,
	renderTemplateStubSource,
	renderValidatorStubSource,
} from "./stubs"

// ---------------------------------------------------------------------------
// The on-disk DELIVER. Writes all the pack files (manifest, recipe
// stubs, validators, templates, package.json, tsconfig.json, README,
// PREFERENCES.md) to the pack directory. Returns the list of files
// written so the CLI can show a diff.
// ---------------------------------------------------------------------------

interface WriteFilesResult {
	writtenFiles: string[]
}

export function writePackFiles(args: {
	packDir: string
	packName: string
	state: DesignSessionState
}): WriteFilesResult {
	const { packDir, packName, state } = args
	mkdirSync(packDir, { recursive: true })

	const written: string[] = []

	const manifest = renderManifestSource({
		packName,
		description: state.prefs?.split("\n")[0] ?? "Auto-generated pack.",
		deps: [],
		recipes: (state.designedRecipes ?? []).map((a) => ({
			id: a.id,
			description: a.description,
			params: a.params,
			requiresReasoning: a.requiresReasoning,
			compensatesWith: a.compensatesWith,
			validators: a.validators,
		})),
	})
	writeFileSync(join(packDir, "manifest.ts"), manifest, "utf-8")
	written.push(join(packDir, "manifest.ts"))

	for (const a of state.designedRecipes ?? []) {
		const recipeDir = join(packDir, a.id)
		mkdirSync(recipeDir, { recursive: true })
		writeFileSync(join(recipeDir, "recipe.ts"), renderRecipeStubSource(a), "utf-8")
		written.push(join(recipeDir, "recipe.ts"))

		for (const v of a.validators) {
			mkdirSync(join(recipeDir, "validators"), { recursive: true })
			writeFileSync(join(recipeDir, "validators", `${v.id}.ts`), renderValidatorStubSource(v.id, v.purpose), "utf-8")
			written.push(join(recipeDir, "validators", `${v.id}.ts`))
		}

		if (a.requiresReasoning) {
			mkdirSync(join(recipeDir, "templates"), { recursive: true })
			for (const t of a.templates ?? []) {
				writeFileSync(
					join(recipeDir, "templates", `${t.id}.hbs`),
					renderTemplateStubSource(a.id, t.id, t.outline),
					"utf-8",
				)
				written.push(join(recipeDir, "templates", `${t.id}.hbs`))
			}
		}
	}

	writeFileSync(
		join(packDir, "package.json"),
		`{
  "name": "@${packName}",
  "version": "0.1.0",
  "private": true,
  "main": "./manifest.ts",
  "dependencies": {
    "baka-sdk": "workspace:*"
  },
  "peerDependencies": {
    "baka": "*"
  },
  "keywords": ["baka-pack"]
}
`,
		"utf-8",
	)
	written.push(join(packDir, "package.json"))

	writeFileSync(
		join(packDir, "tsconfig.json"),
		`{
  "extends": "@repo/typescript-config/base.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "baka-sdk": ["../../packages/baka-sdk/src/index.ts"]
    }
  },
  "include": ["**/*.ts"]
}
`,
		"utf-8",
	)
	written.push(join(packDir, "tsconfig.json"))

	const recipes = state.designedRecipes ?? []
	writeFileSync(
		join(packDir, "README.md"),
		renderReadmeSource({ packName, prefs: state.prefs ?? "", recipes }),
		"utf-8",
	)
	written.push(join(packDir, "README.md"))

	if (state.prefs) {
		writeFileSync(join(packDir, "PREFERENCES.md"), renderPreferencesFile(packName, state.prefs), "utf-8")
		written.push(join(packDir, "PREFERENCES.md"))
	}

	return { writtenFiles: written }
}
