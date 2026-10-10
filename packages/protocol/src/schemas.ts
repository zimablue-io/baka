import { z } from "zod"
import { ENGINE_STATUS, RECIPE_ERROR_CODES } from "./constants"
import { AgentRole } from "./types"

// ---------------------------------------------------------------------------
// Pack manifest
// ---------------------------------------------------------------------------

/**
 * A param's type, as a manifest declares it. Scalars (`string`, `number`,
 * `boolean`), `enum` (needs `enumValues`), `array` (needs `items`, the element
 * type), and `object` (needs `properties`, its fields as params). `default`
 * is a JSON value of that type and makes the param optional.
 */
export const PARAM_TYPES = ["string", "boolean", "number", "enum", "array", "object"] as const
export type ParamType = (typeof PARAM_TYPES)[number]

/**
 * Named string formats a `string` param may declare with `format`. Each is a
 * regular expression (so JSON Schema carries it as `pattern`) and is the
 * conventional way to keep a param safe to interpolate into a path.
 *
 * - `slug`: lowercase letters and digits, words joined by single hyphens (`my-app`).
 * - `path-segment`: one path component: no `/`, backslash, or control character, and not `.` or `..`.
 * - `relative-path`: a POSIX path below the project root: not absolute, no `..` segment, no backslash or control character.
 * - `identifier`: a JavaScript identifier (`[A-Za-z_$][A-Za-z0-9_$]*`).
 * - `package-name`: an npm package name, optionally scoped (`@scope/name`).
 */
export const PARAM_FORMATS = {
	slug: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
	"path-segment": "^(?!\\.{1,2}$)[^/\\\\\\u0000-\\u001f]+$",
	"relative-path": "^(?!/)(?!(?:.*/)?\\.\\.(?:/|$))[^\\\\\\u0000-\\u001f]+$",
	identifier: "^[A-Za-z_$][A-Za-z0-9_$]*$",
	"package-name": "^(?:@[a-z0-9-~][a-z0-9-._~]*/)?[a-z0-9-~][a-z0-9-._~]*$",
} as const
export type ParamFormat = keyof typeof PARAM_FORMATS
const PARAM_FORMAT_NAMES = Object.keys(PARAM_FORMATS) as [ParamFormat, ...ParamFormat[]]

export interface ParamTypeNode {
	type: ParamType
	description?: string
	enumValues?: string[]
	default?: unknown
	items?: ParamTypeNode
	properties?: PackRecipeParam[]
	/** `string` only: a regular expression the value must match (unanchored, as in JSON Schema; anchor it with `^` and `$`). */
	pattern?: string
	/** `string` only: minimum length in UTF-16 code units. */
	minLength?: number
	/** `string` only: maximum length in UTF-16 code units. */
	maxLength?: number
	/** `string` only: one of the named formats in PARAM_FORMATS. */
	format?: ParamFormat
}

export interface PackRecipeParam extends ParamTypeNode {
	name: string
	required: boolean
	description: string
}

const ParamTypeNodeShape = {
	type: z.enum(PARAM_TYPES),
	enumValues: z.array(z.string()).optional(), // required when type === "enum"
	default: z.unknown().optional(),
	items: z.lazy((): z.ZodType<ParamTypeNode> => ParamTypeNodeSchema).optional(), // required when type === "array"
	properties: z.lazy((): z.ZodType<PackRecipeParam[]> => z.array(PackRecipeParamSchema)).optional(), // required when type === "object"
	pattern: z.string().optional(), // string only
	minLength: z.number().int().nonnegative().optional(), // string only
	maxLength: z.number().int().nonnegative().optional(), // string only
	format: z.enum(PARAM_FORMAT_NAMES).optional(), // string only
}

/** The cross-field rules a type declaration must satisfy; `ctx` receives one issue per violation. */
function checkParamNode(node: ParamTypeNode, ctx: z.RefinementCtx): void {
	const need = (ok: boolean, field: string, type: ParamType): void => {
		if (node.type === type && !ok)
			ctx.addIssue({ code: "custom", path: [field], message: `${type} params need ${field}` })
		if (node.type !== type && node[field as keyof ParamTypeNode] !== undefined) {
			ctx.addIssue({ code: "custom", path: [field], message: `${field} is only valid on ${type} params` })
		}
	}
	need((node.enumValues?.length ?? 0) > 0, "enumValues", "enum")
	need(node.items !== undefined, "items", "array")
	need(node.properties !== undefined, "properties", "object")
	for (const field of ["pattern", "minLength", "maxLength", "format"] as const) {
		if (node.type !== "string" && node[field] !== undefined) {
			ctx.addIssue({ code: "custom", path: [field], message: `${field} is only valid on string params` })
		}
	}
	if (node.pattern !== undefined) {
		try {
			new RegExp(node.pattern)
		} catch (err) {
			ctx.addIssue({
				code: "custom",
				path: ["pattern"],
				message: `pattern is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
			})
		}
	}
	if (node.minLength !== undefined && node.maxLength !== undefined && node.minLength > node.maxLength) {
		ctx.addIssue({ code: "custom", path: ["maxLength"], message: "maxLength must not be less than minLength" })
	}
	if (node.default !== undefined && !paramNodeToZod(node).safeParse(node.default).success) {
		ctx.addIssue({ code: "custom", path: ["default"], message: `default does not match type ${node.type}` })
	}
}

export const ParamTypeNodeSchema: z.ZodType<ParamTypeNode> = z
	.object({ ...ParamTypeNodeShape, description: z.string().optional() })
	.superRefine(checkParamNode)

export const PackRecipeParamSchema: z.ZodType<PackRecipeParam> = z
	.object({
		...ParamTypeNodeShape,
		name: z.string().min(1),
		required: z.boolean(),
		description: z.string(),
	})
	.superRefine((param, ctx) => {
		checkParamNode(param, ctx)
		if (param.required && param.default !== undefined) {
			ctx.addIssue({ code: "custom", path: ["default"], message: "a param with a default cannot be required" })
		}
	})

/** The Zod validator for one declared type (no name, no required flag). */
function paramNodeToZod(node: ParamTypeNode): z.ZodTypeAny {
	let schema: z.ZodTypeAny
	switch (node.type) {
		case "string": {
			let str = z.string()
			if (node.minLength !== undefined) str = str.min(node.minLength)
			if (node.maxLength !== undefined) str = str.max(node.maxLength)
			if (node.format !== undefined) str = str.regex(new RegExp(PARAM_FORMATS[node.format]), `must be a ${node.format}`)
			if (node.pattern !== undefined) str = str.regex(new RegExp(node.pattern), `must match ${node.pattern}`)
			schema = str
			break
		}
		case "number":
			schema = z.number()
			break
		case "boolean":
			schema = z.boolean()
			break
		case "enum":
			schema = z.enum((node.enumValues ?? []) as [string, ...string[]])
			break
		case "array":
			schema = z.array(node.items ? paramNodeToZod(node.items) : z.unknown())
			break
		case "object":
			schema = paramsToZod(node.properties ?? [])
			break
	}
	if (node.description) schema = schema.describe(node.description)
	if (node.default !== undefined) schema = schema.default(node.default)
	return schema
}

/**
 * The strict Zod object for a recipe's declared params. A param is optional
 * unless it is `required` (and has no default); undeclared keys are rejected.
 */
export function paramsToZod(params: readonly PackRecipeParam[]): z.ZodObject<z.ZodRawShape> {
	const shape: z.ZodRawShape = {}
	for (const param of params) {
		const field = paramNodeToZod(param)
		// A default already makes the input optional (and must not be wrapped, or it never applies).
		shape[param.name] = param.required || param.default !== undefined ? field : field.optional()
	}
	return z.object(shape).strict()
}

export const PackRecipeSchema = z.object({
	id: z.string().min(1),
	description: z.string(),
	params: z.array(PackRecipeParamSchema).superRefine((params, ctx) => {
		const seen = new Set<string>()
		params.forEach((param, index) => {
			if (param.name === "data") {
				ctx.addIssue({
					code: "custom",
					path: [index, "name"],
					message: 'the param name "data" is reserved: templates and recipe.ts read the pack\'s data files as `data`',
				})
			}
			if (seen.has(param.name))
				ctx.addIssue({ code: "custom", path: [index, "name"], message: `duplicate param "${param.name}"` })
			seen.add(param.name)
		})
	}),
	requiresReasoning: z.boolean().default(false),
	compensatesWith: z.string().optional(),
	filePatterns: z.array(z.string()).default([]),
	validators: z.array(z.string()).default([]),
	/**
	 * A recipe with a `recipe.ts` can be dry-run only if it says so here: it
	 * then promises to write solely through `ctx.files` while `ctx.dryRun` is
	 * true (Baka checks the tree is unchanged afterwards). Template-only
	 * recipes are always dry-runnable and ignore this.
	 */
	supportsDryRun: z.boolean().optional(),
	/**
	 * How `baka validate` (which runs no recipe) recognises that this recipe's
	 * output is present: glob patterns relative to the project root (`*` within
	 * a segment, `**` across segments, `?`). When any file matches, the
	 * recipe's validators run with `state.run.ran === false`. Without a
	 * marker the recipe's validators run only after the recipe itself ran.
	 */
	marker: z.array(z.string().min(1)).optional(),
	/**
	 * A command that formats this recipe's generated files, run by Baka only
	 * when the caller asks (`runRecipe({ format: true })`, `baka run --format`)
	 * and by the caller itself otherwise. `{files}` in `args` expands to the
	 * files the run created or updated (project-relative, one argument each);
	 * without it they are appended. See docs/PACKS.md, "Formatting generated output".
	 */
	format: z
		.object({
			command: z.string().min(1),
			args: z.array(z.string()).default([]),
		})
		.optional(),
	/**
	 * Optional toolchain the registry should run against the
	 * dry-run output for this recipe. Today only `tsc` is
	 * declarable (architecture §4.6 layer 3); the closed set is
	 * a deliberate cap so the registry can stay honest about
	 * what tools it runs and how their failures are surfaced.
	 */
	toolchain: z.enum(["tsc"]).optional(),
})

// ---------------------------------------------------------------------------
// Slot-native templates (docs/superpowers/specs/2026-08-25-slot-native-templates.md)
// ---------------------------------------------------------------------------

export const SlotKindSchema = z.enum(["prose", "ident", "list", "json"])

export const SlotDeclSchema = z.object({
	id: z.string().min(1),
	kind: SlotKindSchema,
	hint: z.string(),
	file: z.string().min(1),
	max: z.number().int().positive().optional(),
	item: z.string().optional(),
	schemaPath: z.string().optional(),
})

export const SlotFillSchema = z.object({
	value: z.union([z.string(), z.array(z.string()), z.record(z.unknown())]),
})

export const PackManifestSchema = z.object({
	name: z.string().min(1),
	version: z.string().min(1),
	description: z.string().default(""),
	dependencies: z.array(z.string()).default([]),
	conflictsWith: z.array(z.string()).default([]),
	recipes: z.array(PackRecipeSchema).min(1),
	packValidators: z.array(z.string()).default([]),
})

// ---------------------------------------------------------------------------
// Resolved plan (output of the Orchestrator, input to the Worker)
// ---------------------------------------------------------------------------

export const ResolvedPlanStepSchema = z.object({
	id: z.string(),
	pack: z.string(),
	recipe: z.string(),
	params: z.record(z.any()),
})

export const ResolvedPlanSchema = z.object({
	resolvedSteps: z.array(ResolvedPlanStepSchema),
})

/**
 * What happened to one path.
 * - `create`: the file did not exist and was written.
 * - `update`: the file existed with other content and was rewritten.
 * - `delete`: the file existed before and is gone after (side-effect recipes only).
 * - `unchanged`: the file already held exactly the bytes the recipe would write.
 * - `skip`: the file exists with other content and the recipe left it alone.
 */
export const ChangeOpSchema = z.enum(["create", "update", "delete", "unchanged", "skip"])

export const ChangeReasonSchema = z.enum(["identical", "already-exists"])

export const ChangesetEntrySchema = z.object({
	/** Project-relative POSIX path. */
	path: z.string(),
	op: ChangeOpSchema,
	/** sha256 (lowercase hex) of the file's bytes after the recipe; null for `delete`. */
	contentHash: z.string().nullable(),
	/** Why nothing was written: `identical` for `unchanged`, `already-exists` for `skip`. */
	reason: ChangeReasonSchema.optional(),
	/**
	 * The file's permission bits as four octal digits (`"0755"`), present only
	 * when the template or `ctx.files.write` declared a mode: the declared one
	 * for `create`, `update`, and `unchanged`; the file's actual bits for `skip`.
	 * Part of the file's identity, so it is part of `outputTreeHash` when present.
	 */
	mode: z
		.string()
		.regex(/^[0-7]{4}$/)
		.optional(),
	/** The file's UTF-8 text after the recipe. Only present when the caller asked for content, and never for `delete` or `skip`. */
	content: z.string().optional(),
})

/**
 * The run a validator is judging, set on `state.run` (see docs/PACKS.md,
 * "Validators"). `ran` says whether the recipe ran in this invocation:
 * true after `runRecipe` (or an apply step), false when `baka validate`
 * found the recipe's output through its manifest `marker` (then `params`
 * is empty, `compensationData` and `output` are null, and `detected` lists
 * the paths the marker matched).
 */
export const ValidatorRunSchema = z.object({
	pack: z.string(),
	recipe: z.string(),
	ran: z.boolean(),
	/** The params the recipe ran with (normalized); empty when `ran` is false. */
	params: z.record(z.unknown()),
	/** What the recipe's `execute` returned as compensation data (template-only recipes: `{ written }`); null when it did not run. */
	compensationData: z.unknown(),
	/** What the recipe's `execute` returned as output; null for template-only recipes and when it did not run. */
	output: z.unknown(),
	/** The run's changeset; empty when the recipe did not run. */
	changeset: z.array(ChangesetEntrySchema),
	/** When `ran` is false: the project paths the recipe's `marker` matched. */
	detected: z.array(z.string()).optional(),
})

// ---------------------------------------------------------------------------
// Orchestration state
// ---------------------------------------------------------------------------

export const OrchestrationStateSchema = z.object({
	userIntent: z.string(),
	targetDirectory: z.string(),
	/** The directories packs are drawn from, when the caller set them (`--packs-dir`, `BAKA_PACK_DIRS`); absent means the default discovery. */
	packDirs: z.array(z.string()).optional(),
	status: z.nativeEnum(ENGINE_STATUS),
	currentRole: z.nativeEnum(AgentRole).optional(),
	executionPlan: z.object({
		steps: z.array(ResolvedPlanStepSchema),
		currentStepIndex: z.number(),
	}),
	logs: z.array(z.string()),
	artifacts: z.record(z.any()).default({}),
	/** Set for validators only: the recipe run they are judging. */
	run: ValidatorRunSchema.optional(),
})

// ---------------------------------------------------------------------------
// Recipe result (the receipt `runRecipe` returns; also the CLI/MCP/HTTP `--json` shape)
// ---------------------------------------------------------------------------

export const RecipeErrorCodeSchema = z.enum(RECIPE_ERROR_CODES)

export const ValidationDiagnosticSchema = z.object({
	severity: z.enum(["error", "warning"]),
	/** The validator's own rule id; for a failed run, an RecipeErrorCode. */
	rule: z.string(),
	message: z.string(),
	file: z.string().optional(),
	hint: z.string().optional(),
	/** Which validator produced it: `<pack>:<id>` (pack-level) or `<pack>.<recipe>:<id>` (recipe-level). Absent for engine diagnostics. */
	validator: z.string().optional(),
	/** The pack a discovery (structural) diagnostic is about. */
	pack: z.string().optional(),
})

export const SlotRecordSchema = z.object({
	id: z.string(),
	/**
	 * Model-independent identity of the fill: sha256 over the template bytes,
	 * the slot id, and the canonical params (`match` "params"), or over the
	 * template bytes and the slot id alone (`match` "template"). A replay only
	 * accepts a record whose key matches the slot it is about to fill.
	 */
	key: z.string(),
	/**
	 * What the record's `key` covers. `params` (the default, and what every run
	 * reports) fits one set of params. `template` fits any params for the same
	 * template bytes: the shape of a default a catalog ships in a fixture. When a
	 * replay has both for a slot, the record taken against exactly these params wins.
	 */
	match: z.enum(["params", "template"]).optional(),
	/** The model that produced the value (`manual` for a pinned fill, `supplied` for a value the caller passed in). */
	model: z.string(),
	value: SlotFillSchema.shape.value,
	source: z.enum(["llm", "cache", "replay", "supplied"]),
})

/**
 * How slot values are obtained.
 * - `live` (default): values the caller supplies, then the slot cache, then the model; fresh model fills are cached.
 * - `record`: always ask the model (the cache is not read) and cache the fills.
 * - `replay`: use only the supplied records. A slot without a matching record is a
 *   hard error and no model call is ever made.
 */
export const SlotModeSchema = z.enum(["live", "record", "replay"])

/**
 * What a run does with a template target that already exists.
 * - `skip` (default): leave it. Identical content is reported `unchanged`, other content `skip`.
 * - `overwrite`: rewrite it when the content differs (`update`); identical content is `unchanged`.
 * - `fail`: refuse the whole run with `target-exists`, before any slot fill or write.
 */
export const OnExistingSchema = z.enum(["skip", "overwrite", "fail"])

export const SlotsInputSchema = z.object({
	mode: SlotModeSchema,
	/** The records `replay` draws from; ignored by the other modes. */
	records: z.array(SlotRecordSchema).optional(),
	/**
	 * Fills the caller supplies for this call, by slot id. They win over the cache and the
	 * model, are never cached, and need no model at all; an id the recipe does not declare
	 * fails the run with `slot-unknown`. Ignored by `replay`.
	 */
	values: z.record(z.unknown()).optional(),
})

/** A slot a run could not fill because no value, cached fill or model was available: what a caller must supply. */
export const OpenSlotSchema = SlotDeclSchema.extend({
	/** The `key` a `match: "template"` slot record for this slot must carry. */
	templateKey: z.string(),
})

export const RecipeCompensationSchema = z.object({
	/** Paths this run created; compensation deletes them. */
	created: z.array(z.string()),
	/** Directories this run created, in creation order; compensation removes them (deepest first) once empty. */
	createdDirs: z.array(z.string()),
	/** Files this run overwrote or deleted, with their previous bytes; compensation restores them. */
	overwritten: z.array(
		z.object({
			path: z.string(),
			contentBase64: z.string(),
			/** The file's previous permission bits (`"0644"`), when the run changed them. */
			mode: z.string().optional(),
		}),
	),
	/** What the recipe's own `execute` returned as compensation data; handed back to its `compensate`. */
	recipeData: z.unknown(),
})

/** A pack as a run used it: its manifest name and version, and a hash of its files. */
export const PackPinSchema = z.object({
	id: z.string(),
	version: z.string(),
	/** sha256 (lowercase hex) over the pack's canonical file list; see docs/PACKS.md. */
	contentHash: z.string(),
})

/** `baka.lock.json`: the pins a project insists on, keyed by pack id. */
export const BakaLockSchema = z.object({
	lockfileVersion: z.literal(1),
	packs: z.record(z.object({ version: z.string(), contentHash: z.string() })),
})

export const RecipeResultSchema = z.object({
	/** The id of this document in the published contract (docs/CONTRACT.md). */
	schema: z.literal("baka.receipt/1"),
	ok: z.boolean(),
	pack: z.string(),
	recipe: z.string(),
	/** The params the run used: the declared defaults applied and scalars coerced. The input as given when they did not validate. */
	params: z.record(z.unknown()),
	/** Error diagnostics (a failed run carries one whose `rule` is an RecipeErrorCode) plus validator output, warnings included. */
	diagnostics: z.array(ValidationDiagnosticSchema),
	changeset: z.array(ChangesetEntrySchema),
	/** sha256 over the canonical (path, contentHash) list of the changeset; see docs/PACKS.md. */
	outputTreeHash: z.string(),
	/** The pack this run used, as resolved. Empty when the pack could not be resolved. */
	pins: z.array(PackPinSchema),
	slots: z.array(SlotRecordSchema),
	/** Present only when the run failed with `slots-open`: every slot that still needs a value. Pass them back as `slots.values`. */
	openSlots: z.array(OpenSlotSchema).optional(),
	compensation: RecipeCompensationSchema,
	/** What the recipe's `execute` returned (side-effect recipes); null for template-only recipes. */
	output: z.unknown(),
	dryRun: z.boolean(),
})

/**
 * A model chosen for one call, instead of the user's stored config. Nothing here is remembered.
 * The key is never on a command line: name the environment variable that holds it (`apiKeyEnv`),
 * or pass `apiKey` over a channel you trust (a process environment, a bearer-authenticated request).
 */
export const LlmCallSchema = z.object({
	baseUrl: z.string().min(1).optional(),
	model: z.string().min(1).optional(),
	apiKey: z.string().min(1).optional(),
	apiKeyEnv: z.string().min(1).optional(),
	temperature: z.number().optional(),
	maxTokens: z.number().int().positive().optional(),
	timeoutMs: z.number().int().positive().optional(),
	seed: z.number().int().optional(),
})

/** What every failure that is not a run receipt looks like, over HTTP and from `--json` commands. */
export const ApiErrorSchema = z.object({
	error: z.object({
		code: z.string().min(1),
		message: z.string(),
		hint: z.string().optional(),
	}),
})
