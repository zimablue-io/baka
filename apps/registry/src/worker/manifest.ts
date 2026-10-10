import { readdir, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { type PackManifest, PackManifestSchema } from "@repo/protocol"
import { createJiti } from "jiti"

/**
 * Manifest + recipe loader gate (architecture §4.5 step 3 + step 4).
 *
 * The publish endpoint reads `name` and `version` from a sandboxed
 * `vm` so a malicious manifest cannot wedge the request. The worker
 * runs the FULL `PackManifestSchema` validation through `jiti` so
 * the canonical manifest is what the DB stores, the catalog
 * surfaces, and downstream consumers see. The `jiti` import also
 * evaluates the pack's `recipe.ts` files headless — every recipe
 * id declared in the manifest must resolve through the real engine
 * loader (the same resolution order the engine uses at runtime,
 * pinned by VAL-FOUND-021).
 *
 * Scrutiny-round-1 fix #3: the loadability gate now extends beyond
 * `manifest.recipes` to pack validators (`_shared/validators/<id>.ts`,
 * id in `manifest.packValidators`) and per-recipe validators
 * (`<recipeId>/validators/<id>.ts`, id in `recipe.validators`). The
 * engine's real resolution paths are at `packages/ast-tooling/src/
 * recipe-loader.ts` (`loadPackValidator` and `loadRecipeValidator`);
 * the gate here mirrors them so a pack that declares a missing or
 * unloadable validator cannot reach `ready`.
 */

interface IngestError {
	step: "manifest" | "loadability" | "screening"
	message: string
}

/**
 * Reads, evaluates, and validates the manifest at
 * `<packDir>/manifest.ts` via jiti. The full `PackManifestSchema`
 * is applied so any malformed payload is rejected here — the
 * worker does not trust the publish endpoint's narrower reader.
 *
 * Returns the validated `PackManifest` on success; throws on
 * filesystem errors (caller catches and converts to IngestError).
 */
export async function loadManifest(packDir: string): Promise<PackManifest> {
	const manifestPath = join(packDir, "manifest.ts")
	const jiti = createJiti(packDir, { interopDefault: true })
	// jiti evaluates the TS source and returns the default export.
	// `interopDefault` collapses ESM `export default { ... }` into
	// the bare object — the standard pattern the rest of the engine
	// uses for pack entry points.
	const mod = jiti(manifestPath) as Record<string, unknown>
	const candidate = (mod.default ?? mod) as unknown
	const parsed = PackManifestSchema.safeParse(candidate)
	if (!parsed.success) {
		const first = parsed.error.issues[0]
		const path = first ? first.path.join(".") || "(root)" : "(unknown)"
		const reason = first ? first.message : "schema validation failed"
		throw new IngestFailure("manifest", `manifest failed schema validation at '${path}': ${reason}`)
	}
	return parsed.data
}

/**
 * Walks the pack's `recipe.ts` exports and the validator files
 * the manifest declares, and verifies every id resolves through
 * the engine's real loader. Pinned by VAL-FOUND-021 for recipes
 * and by `packages/ast-tooling/src/recipe-loader.ts`'s
 * `loadPackValidator` / `loadRecipeValidator` for validators.
 *
 * Throws `IngestFailure` naming the first unloadable id. The row
 * terminates `failed` with the diagnostic so callers can pin
 * VAL-PUB-014 (recipe), and the new validator cases (missing
 * pack validator, missing recipe validator) get the same
 * treatment.
 */
export async function checkLoadability(packDir: string, manifest: PackManifest): Promise<void> {
	const jiti = createJiti(packDir, { interopDefault: true })

	// Pack-level validators: `_shared/validators/<kebabId>.ts`. jiti
	// throws a non-IngestFailure on syntax errors; we rewrap so the
	// wrapper in `ingest.ts` records the diagnostic verbatim.
	for (const validatorId of manifest.packValidators ?? []) {
		const validatorPath = join(packDir, "_shared", "validators", `${kebabCase(validatorId)}.ts`)
		if (!(await pathExists(validatorPath))) {
			throw new IngestFailure("loadability", `pack validator '${validatorId}' has no file at '${validatorPath}'`)
		}
		try {
			const mod = jiti(validatorPath) as Record<string, unknown>
			const fn = (mod[validatorId] ?? mod.default) as unknown
			if (typeof fn !== "function") {
				throw new IngestFailure(
					"loadability",
					`pack validator '${validatorId}' must export a function named '${validatorId}' (or as the default export)`,
				)
			}
		} catch (err) {
			if (err instanceof IngestFailure) throw err
			const message = err instanceof Error ? err.message : String(err)
			throw new IngestFailure(
				"loadability",
				`pack validator '${validatorId}' at '${validatorPath}' failed to load: ${message}`,
			)
		}
	}

	// Per-recipe files and per-recipe validators. Recipe resolution
	// order is pinned by VAL-FOUND-021: camelCase(id), camelCase(id)+
	// "Recipe", exact id, id+"Recipe", "default".
	for (const recipe of manifest.recipes) {
		const recipeDir = join(packDir, recipe.id)
		const recipePath = join(recipeDir, "recipe.ts")
		if (!(await pathExists(recipePath))) {
			throw new IngestFailure("loadability", `recipe '${recipe.id}' has no recipe.ts at '${recipePath}'`)
		}
		const mod = jiti(recipePath) as Record<string, unknown>
		const resolved = resolveRecipeExport(mod, recipe.id)
		if (resolved === null) {
			throw new IngestFailure(
				"loadability",
				`recipe '${recipe.id}' does not export a WorkflowStep; ` +
					`expected one of '${toCamelCase(recipe.id)}', '${toCamelCase(recipe.id)}Recipe', ` +
					`'${recipe.id}', '${recipe.id}Recipe', or a default export`,
			)
		}
		// Per-recipe validators (architecture §4.5 + recipe-loader.ts
		// `loadRecipeValidator`): live at `<recipeId>/validators/<kebabId>.ts`.
		for (const validatorId of recipe.validators ?? []) {
			const validatorPath = join(recipeDir, "validators", `${kebabCase(validatorId)}.ts`)
			if (!(await pathExists(validatorPath))) {
				throw new IngestFailure(
					"loadability",
					`recipe '${recipe.id}' validator '${validatorId}' has no file at '${validatorPath}'`,
				)
			}
			try {
				const validatorMod = jiti(validatorPath) as Record<string, unknown>
				const fn = (validatorMod[validatorId] ?? validatorMod.default) as unknown
				if (typeof fn !== "function") {
					throw new IngestFailure(
						"loadability",
						`recipe '${recipe.id}' validator '${validatorId}' must export a function named '${validatorId}' (or as the default export)`,
					)
				}
			} catch (err) {
				if (err instanceof IngestFailure) throw err
				const message = err instanceof Error ? err.message : String(err)
				throw new IngestFailure(
					"loadability",
					`recipe '${recipe.id}' validator '${validatorId}' at '${validatorPath}' failed to load: ${message}`,
				)
			}
		}
	}
}

/**
 * Resolves the recipe export through the engine's resolution order
 * (architecture §3.1 — pinned by VAL-FOUND-021). Returns the
 * resolved WorkflowStep on success, null on failure. The check is
 * `execute && compensate` — every recipe must be a WorkflowStep
 * (the contract every engine consumer relies on).
 */
function resolveRecipeExport(mod: Record<string, unknown>, recipeId: string): unknown {
	const camelCaseId = toCamelCase(recipeId)
	const candidates = [camelCaseId, `${camelCaseId}Recipe`, recipeId, `${recipeId}Recipe`, "default"]
	for (const name of candidates) {
		const c = mod[name] as { execute?: unknown; compensate?: unknown } | undefined
		if (c && typeof c.execute === "function" && typeof c.compensate === "function") {
			return c
		}
	}
	return null
}

/**
 * Lists the pack's files relative to `packDir` (sorted, dot-files
 * excluded). Used by the content-hash step — the canonical ordering
 * makes the hash stable across runs and across publishes of the same
 * tree at different tags.
 *
 * The `manifest.ts`/`manifest.json` file is EXCLUDED from the file
 * list — it is metadata, not pack content. Two publishes of the
 * same RECIPE TREE at different tags (manifest version bumps)
 * produce identical tarballs and dedupe to one artifact blob on
 * disk. The manifest is still validated against the tag by the
 * publish endpoint (decision 11), so the version field on the row
 * always matches the tag — the manifest content is just not
 * included in the tarball.
 */
export async function listPackFiles(packDir: string): Promise<string[]> {
	const out: string[] = []
	await walk(packDir, packDir, out)
	return out.sort()
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true })
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue
		const fullPath = join(dir, entry.name)
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "out") continue
			await walk(root, fullPath, out)
		} else if (entry.isFile()) {
			const relPath = resolve(fullPath).slice(resolve(root).length + 1)
			// Skip manifest files — they are metadata, not
			// pack content, and bumping the manifest version
			// should not invalidate the artifact blob dedup.
			if (relPath === "manifest.ts" || relPath === "manifest.json") continue
			out.push(relPath)
		}
	}
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await stat(p)
		return true
	} catch {
		return false
	}
}

function toCamelCase(id: string): string {
	return id.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

/**
 * Convert a camelCase validator id (e.g. "hasPackageJson") to its
 * kebab-case filename stem (e.g. "has-package-json"). Mirrors
 * `validatorFilename` in `packages/ast-tooling/src/recipe-loader.ts`
 * so the gate's path layout exactly matches the engine's.
 */
function kebabCase(id: string): string {
	return id.replace(/[A-Z]/g, (m, offset) => (offset > 0 ? "-" : "") + m.toLowerCase())
}

/**
 * Error type raised by the manifest/loadability gate. The worker
 * catches and stores the message verbatim in `pack_versions.error`.
 */
export class IngestFailure extends Error {
	readonly step: IngestError["step"]
	constructor(step: IngestError["step"], message: string) {
		super(message)
		this.step = step
		this.name = "IngestFailure"
	}
}
