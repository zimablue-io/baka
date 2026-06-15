import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { DesignSessionState } from "../state"
import { renderPreferencesFile, renderReadmeSource } from "./docs"
import {
	renderActionStubSource,
	renderManifestSource,
	renderTemplateStubSource,
	renderValidatorStubSource,
} from "./stubs"

// ---------------------------------------------------------------------------
// The on-disk DELIVER. Writes all the module files (manifest, action
// stubs, validators, templates, package.json, tsconfig.json, README,
// PREFERENCES.md) to the module directory. Returns the list of files
// written so the CLI can show a diff.
// ---------------------------------------------------------------------------

export interface WriteFilesResult {
	writtenFiles: string[]
}

export function writeModuleFiles(args: {
	moduleDir: string
	moduleName: string
	state: DesignSessionState
}): WriteFilesResult {
	const { moduleDir, moduleName, state } = args
	mkdirSync(moduleDir, { recursive: true })

	const written: string[] = []

	const manifest = renderManifestSource({
		moduleName,
		description: state.prefs?.split("\n")[0] ?? "Auto-generated module.",
		deps: [],
		actions: (state.designedActions ?? []).map((a) => ({
			id: a.id,
			description: a.description,
			params: a.params,
			requiresReasoning: a.requiresReasoning,
			compensatesWith: a.compensatesWith,
			validators: a.validators,
		})),
	})
	writeFileSync(join(moduleDir, "manifest.ts"), manifest, "utf-8")
	written.push(join(moduleDir, "manifest.ts"))

	for (const a of state.designedActions ?? []) {
		const actionDir = join(moduleDir, a.id)
		mkdirSync(actionDir, { recursive: true })
		writeFileSync(join(actionDir, "action.ts"), renderActionStubSource(a), "utf-8")
		written.push(join(actionDir, "action.ts"))

		for (const v of a.validators) {
			mkdirSync(join(actionDir, "validators"), { recursive: true })
			writeFileSync(join(actionDir, "validators", `${v.id}.ts`), renderValidatorStubSource(v.id, v.purpose), "utf-8")
			written.push(join(actionDir, "validators", `${v.id}.ts`))
		}

		if (a.requiresReasoning) {
			mkdirSync(join(actionDir, "templates"), { recursive: true })
			for (const t of a.templates ?? []) {
				writeFileSync(
					join(actionDir, "templates", `${t.id}.hbs`),
					renderTemplateStubSource(a.id, t.id, t.outline),
					"utf-8",
				)
				written.push(join(actionDir, "templates", `${t.id}.hbs`))
			}
		}
	}

	writeFileSync(
		join(moduleDir, "package.json"),
		`{
  "name": "@${moduleName}",
  "version": "0.1.0",
  "private": true,
  "main": "./manifest.ts",
  "dependencies": {
    "baka-sdk": "workspace:*"
  },
  "peerDependencies": {
    "baka": "*"
  },
  "keywords": ["baka-module"]
}
`,
		"utf-8",
	)
	written.push(join(moduleDir, "package.json"))

	writeFileSync(
		join(moduleDir, "tsconfig.json"),
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
	written.push(join(moduleDir, "tsconfig.json"))

	const actions = state.designedActions ?? []
	writeFileSync(
		join(moduleDir, "README.md"),
		renderReadmeSource({ moduleName, prefs: state.prefs ?? "", actions }),
		"utf-8",
	)
	written.push(join(moduleDir, "README.md"))

	if (state.prefs) {
		writeFileSync(join(moduleDir, "PREFERENCES.md"), renderPreferencesFile(moduleName, state.prefs), "utf-8")
		written.push(join(moduleDir, "PREFERENCES.md"))
	}

	return { writtenFiles: written }
}
