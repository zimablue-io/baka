import { readdir, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { type ModuleManifest, ModuleManifestSchema } from "@repo/protocol"
import { createJiti } from "jiti"

/**
 * Manifest + action loader gate (architecture §4.5 step 3 + step 4).
 *
 * The publish endpoint reads `name` and `version` from a sandboxed
 * `vm` so a malicious manifest cannot wedge the request. The worker
 * runs the FULL `ModuleManifestSchema` validation through `jiti` so
 * the canonical manifest is what the DB stores, the catalog
 * surfaces, and downstream consumers see. The `jiti` import also
 * evaluates the module's `action.ts` files headless — every action
 * id declared in the manifest must resolve through the real engine
 * loader (the same resolution order the engine uses at runtime,
 * pinned by VAL-FOUND-021).
 *
 * Scrutiny-round-1 fix #3: the loadability gate now extends beyond
 * `manifest.actions` to module validators (`_shared/validators/<id>.ts`,
 * id in `manifest.moduleValidators`) and per-action validators
 * (`<actionId>/validators/<id>.ts`, id in `action.validators`). The
 * engine's real resolution paths are at `packages/ast-tooling/src/
 * action-loader.ts` (`loadModuleValidator` and `loadActionValidator`);
 * the gate here mirrors them so a module that declares a missing or
 * unloadable validator cannot reach `ready`.
 */

interface IngestError {
	step: "manifest" | "loadability"
	message: string
}

/**
 * Reads, evaluates, and validates the manifest at
 * `<moduleDir>/manifest.ts` via jiti. The full `ModuleManifestSchema`
 * is applied so any malformed payload is rejected here — the
 * worker does not trust the publish endpoint's narrower reader.
 *
 * Returns the validated `ModuleManifest` on success; throws on
 * filesystem errors (caller catches and converts to IngestError).
 */
export async function loadManifest(moduleDir: string): Promise<ModuleManifest> {
	const manifestPath = join(moduleDir, "manifest.ts")
	const jiti = createJiti(moduleDir, { interopDefault: true })
	// jiti evaluates the TS source and returns the default export.
	// `interopDefault` collapses ESM `export default { ... }` into
	// the bare object — the standard pattern the rest of the engine
	// uses for module entry points.
	const mod = jiti(manifestPath) as Record<string, unknown>
	const candidate = (mod.default ?? mod) as unknown
	const parsed = ModuleManifestSchema.safeParse(candidate)
	if (!parsed.success) {
		const first = parsed.error.issues[0]
		const path = first ? first.path.join(".") || "(root)" : "(unknown)"
		const reason = first ? first.message : "schema validation failed"
		throw new IngestFailure("manifest", `manifest failed schema validation at '${path}': ${reason}`)
	}
	return parsed.data
}

/**
 * Walks the module's `action.ts` exports and the validator files
 * the manifest declares, and verifies every id resolves through
 * the engine's real loader. Pinned by VAL-FOUND-021 for actions
 * and by `packages/ast-tooling/src/action-loader.ts`'s
 * `loadModuleValidator` / `loadActionValidator` for validators.
 *
 * Throws `IngestFailure` naming the first unloadable id. The row
 * terminates `failed` with the diagnostic so callers can pin
 * VAL-PUB-014 (action), and the new validator cases (missing
 * module validator, missing action validator) get the same
 * treatment.
 */
export async function checkLoadability(moduleDir: string, manifest: ModuleManifest): Promise<void> {
	const jiti = createJiti(moduleDir, { interopDefault: true })

	// Module-level validators: `_shared/validators/<kebabId>.ts`. jiti
	// throws a non-IngestFailure on syntax errors; we rewrap so the
	// wrapper in `ingest.ts` records the diagnostic verbatim.
	for (const validatorId of manifest.moduleValidators ?? []) {
		const validatorPath = join(moduleDir, "_shared", "validators", `${kebabCase(validatorId)}.ts`)
		if (!(await pathExists(validatorPath))) {
			throw new IngestFailure("loadability", `module validator '${validatorId}' has no file at '${validatorPath}'`)
		}
		try {
			const mod = jiti(validatorPath) as Record<string, unknown>
			const fn = (mod[validatorId] ?? mod.default) as unknown
			if (typeof fn !== "function") {
				throw new IngestFailure(
					"loadability",
					`module validator '${validatorId}' must export a function named '${validatorId}' (or as the default export)`,
				)
			}
		} catch (err) {
			if (err instanceof IngestFailure) throw err
			const message = err instanceof Error ? err.message : String(err)
			throw new IngestFailure(
				"loadability",
				`module validator '${validatorId}' at '${validatorPath}' failed to load: ${message}`,
			)
		}
	}

	// Per-action files and per-action validators. Action resolution
	// order is pinned by VAL-FOUND-021: camelCase(id), camelCase(id)+
	// "Action", exact id, id+"Action", "default".
	for (const action of manifest.actions) {
		const actionDir = join(moduleDir, action.id)
		const actionPath = join(actionDir, "action.ts")
		if (!(await pathExists(actionPath))) {
			throw new IngestFailure("loadability", `action '${action.id}' has no action.ts at '${actionPath}'`)
		}
		const mod = jiti(actionPath) as Record<string, unknown>
		const resolved = resolveActionExport(mod, action.id)
		if (resolved === null) {
			throw new IngestFailure(
				"loadability",
				`action '${action.id}' does not export a WorkflowStep; ` +
					`expected one of '${toCamelCase(action.id)}', '${toCamelCase(action.id)}Action', ` +
					`'${action.id}', '${action.id}Action', or a default export`,
			)
		}
		// Per-action validators (architecture §4.5 + action-loader.ts
		// `loadActionValidator`): live at `<actionId>/validators/<kebabId>.ts`.
		for (const validatorId of action.validators ?? []) {
			const validatorPath = join(actionDir, "validators", `${kebabCase(validatorId)}.ts`)
			if (!(await pathExists(validatorPath))) {
				throw new IngestFailure(
					"loadability",
					`action '${action.id}' validator '${validatorId}' has no file at '${validatorPath}'`,
				)
			}
			try {
				const validatorMod = jiti(validatorPath) as Record<string, unknown>
				const fn = (validatorMod[validatorId] ?? validatorMod.default) as unknown
				if (typeof fn !== "function") {
					throw new IngestFailure(
						"loadability",
						`action '${action.id}' validator '${validatorId}' must export a function named '${validatorId}' (or as the default export)`,
					)
				}
			} catch (err) {
				if (err instanceof IngestFailure) throw err
				const message = err instanceof Error ? err.message : String(err)
				throw new IngestFailure(
					"loadability",
					`action '${action.id}' validator '${validatorId}' at '${validatorPath}' failed to load: ${message}`,
				)
			}
		}
	}
}

/**
 * Resolves the action export through the engine's resolution order
 * (architecture §3.1 — pinned by VAL-FOUND-021). Returns the
 * resolved WorkflowStep on success, null on failure. The check is
 * `execute && compensate` — every action must be a WorkflowStep
 * (the contract every engine consumer relies on).
 */
function resolveActionExport(mod: Record<string, unknown>, actionId: string): unknown {
	const camelCaseId = toCamelCase(actionId)
	const candidates = [camelCaseId, `${camelCaseId}Action`, actionId, `${actionId}Action`, "default"]
	for (const name of candidates) {
		const c = mod[name] as { execute?: unknown; compensate?: unknown } | undefined
		if (c && typeof c.execute === "function" && typeof c.compensate === "function") {
			return c
		}
	}
	return null
}

/**
 * Lists the module's files relative to `moduleDir` (sorted, dot-files
 * excluded). Used by the content-hash step — the canonical ordering
 * makes the hash stable across runs and across publishes of the same
 * tree at different tags.
 *
 * The `manifest.ts`/`manifest.json` file is EXCLUDED from the file
 * list — it is metadata, not module content. Two publishes of the
 * same ACTION TREE at different tags (manifest version bumps)
 * produce identical tarballs and dedupe to one artifact blob on
 * disk. The manifest is still validated against the tag by the
 * publish endpoint (decision 11), so the version field on the row
 * always matches the tag — the manifest content is just not
 * included in the tarball.
 */
export async function listModuleFiles(moduleDir: string): Promise<string[]> {
	const out: string[] = []
	await walk(moduleDir, moduleDir, out)
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
			// module content, and bumping the manifest version
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
 * `validatorFilename` in `packages/ast-tooling/src/action-loader.ts`
 * so the gate's path layout exactly matches the engine's.
 */
function kebabCase(id: string): string {
	return id.replace(/[A-Z]/g, (m, offset) => (offset > 0 ? "-" : "") + m.toLowerCase())
}

/**
 * Error type raised by the manifest/loadability gate. The worker
 * catches and stores the message verbatim in `module_versions.error`.
 */
export class IngestFailure extends Error {
	readonly step: IngestError["step"]
	constructor(step: IngestError["step"], message: string) {
		super(message)
		this.step = step
		this.name = "IngestFailure"
	}
}
