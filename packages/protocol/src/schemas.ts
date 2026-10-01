import { z } from "zod"
import { ACTION_ERROR_CODES, ENGINE_STATUS } from "./constants"
import { AgentRole } from "./types"

// ---------------------------------------------------------------------------
// Module manifest
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
	properties?: ModuleActionParam[]
	/** `string` only: a regular expression the value must match (unanchored, as in JSON Schema; anchor it with `^` and `$`). */
	pattern?: string
	/** `string` only: minimum length in UTF-16 code units. */
	minLength?: number
	/** `string` only: maximum length in UTF-16 code units. */
	maxLength?: number
	/** `string` only: one of the named formats in PARAM_FORMATS. */
	format?: ParamFormat
}

export interface ModuleActionParam extends ParamTypeNode {
	name: string
	required: boolean
	description: string
}

const ParamTypeNodeShape = {
	type: z.enum(PARAM_TYPES),
	enumValues: z.array(z.string()).optional(), // required when type === "enum"
	default: z.unknown().optional(),
	items: z.lazy((): z.ZodType<ParamTypeNode> => ParamTypeNodeSchema).optional(), // required when type === "array"
	properties: z.lazy((): z.ZodType<ModuleActionParam[]> => z.array(ModuleActionParamSchema)).optional(), // required when type === "object"
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

export const ModuleActionParamSchema: z.ZodType<ModuleActionParam> = z
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
 * The strict Zod object for an action's declared params. A param is optional
 * unless it is `required` (and has no default); undeclared keys are rejected.
 */
export function paramsToZod(params: readonly ModuleActionParam[]): z.ZodObject<z.ZodRawShape> {
	const shape: z.ZodRawShape = {}
	for (const param of params) {
		const field = paramNodeToZod(param)
		// A default already makes the input optional (and must not be wrapped, or it never applies).
		shape[param.name] = param.required || param.default !== undefined ? field : field.optional()
	}
	return z.object(shape).strict()
}

export const ModuleActionSchema = z.object({
	id: z.string().min(1),
	description: z.string(),
	params: z.array(ModuleActionParamSchema),
	requiresReasoning: z.boolean().default(false),
	compensatesWith: z.string().optional(),
	filePatterns: z.array(z.string()).default([]),
	validators: z.array(z.string()).default([]),
	/**
	 * An action with an `action.ts` can be dry-run only if it says so here: it
	 * then promises to write solely through `ctx.files` while `ctx.dryRun` is
	 * true (Baka checks the tree is unchanged afterwards). Template-only
	 * actions are always dry-runnable and ignore this.
	 */
	supportsDryRun: z.boolean().optional(),
	/**
	 * Optional toolchain the registry should run against the
	 * dry-run output for this action. Today only `tsc` is
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

export const ModuleManifestSchema = z.object({
	name: z.string().min(1),
	version: z.string().min(1),
	description: z.string().default(""),
	dependencies: z.array(z.string()).default([]),
	conflictsWith: z.array(z.string()).default([]),
	actions: z.array(ModuleActionSchema).min(1),
	moduleValidators: z.array(z.string()).default([]),
})

// ---------------------------------------------------------------------------
// Resolved plan (output of the Orchestrator, input to the Worker)
// ---------------------------------------------------------------------------

export const ResolvedPlanStepSchema = z.object({
	id: z.string(),
	module: z.string(),
	action: z.string(),
	params: z.record(z.any()),
})

export const ResolvedPlanSchema = z.object({
	resolvedSteps: z.array(ResolvedPlanStepSchema),
})

// ---------------------------------------------------------------------------
// Orchestration state
// ---------------------------------------------------------------------------

export const OrchestrationStateSchema = z.object({
	userIntent: z.string(),
	targetDirectory: z.string(),
	status: z.nativeEnum(ENGINE_STATUS),
	currentRole: z.nativeEnum(AgentRole).optional(),
	executionPlan: z.object({
		steps: z.array(ResolvedPlanStepSchema),
		currentStepIndex: z.number(),
	}),
	logs: z.array(z.string()),
	artifacts: z.record(z.any()).default({}),
})

// ---------------------------------------------------------------------------
// Action result (the receipt `runAction` returns; also the CLI/MCP/HTTP `--json` shape)
// ---------------------------------------------------------------------------

export const ActionErrorCodeSchema = z.enum(ACTION_ERROR_CODES)

export const ValidationDiagnosticSchema = z.object({
	severity: z.enum(["error", "warning"]),
	rule: z.string(),
	message: z.string(),
	file: z.string().optional(),
	hint: z.string().optional(),
})

/**
 * What happened to one path.
 * - `create`: the file did not exist and was written.
 * - `update`: the file existed with other content and was rewritten.
 * - `delete`: the file existed before and is gone after (side-effect actions only).
 * - `unchanged`: the file already held exactly the bytes the action would write.
 * - `skip`: the file exists with other content and the action left it alone.
 */
export const ChangeOpSchema = z.enum(["create", "update", "delete", "unchanged", "skip"])

export const ChangeReasonSchema = z.enum(["identical", "already-exists"])

export const ChangesetEntrySchema = z.object({
	/** Project-relative POSIX path. */
	path: z.string(),
	op: ChangeOpSchema,
	/** sha256 (lowercase hex) of the file's bytes after the action; null for `delete`. */
	contentHash: z.string().nullable(),
	/** Why nothing was written: `identical` for `unchanged`, `already-exists` for `skip`. */
	reason: ChangeReasonSchema.optional(),
	/** The file's UTF-8 text after the action. Only present when the caller asked for content, and never for `delete` or `skip`. */
	content: z.string().optional(),
})

export const SlotRecordSchema = z.object({
	id: z.string(),
	/**
	 * Model-independent identity of the fill: sha256 over the template bytes,
	 * the slot id, and the canonical params. A replay only accepts a record
	 * whose key matches the slot it is about to fill.
	 */
	key: z.string(),
	/** The model that produced the value (`manual` for a pinned fill). */
	model: z.string(),
	value: SlotFillSchema.shape.value,
	source: z.enum(["llm", "cache", "replay"]),
})

/**
 * How slot values are obtained.
 * - `live` (default): the slot cache first, then the model; fresh fills are cached.
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
})

export const ActionCompensationSchema = z.object({
	/** Paths this run created; compensation deletes them. */
	created: z.array(z.string()),
	/** Directories this run created, in creation order; compensation removes them (deepest first) once empty. */
	createdDirs: z.array(z.string()),
	/** Files this run overwrote, with their previous bytes; compensation restores them. */
	overwritten: z.array(z.object({ path: z.string(), contentBase64: z.string() })),
	/** What the action's own `execute` returned as compensation data; handed back to its `compensate`. */
	actionData: z.unknown(),
})

/** A module as a run used it: its manifest name and version, and a hash of its files. */
export const ModulePinSchema = z.object({
	id: z.string(),
	version: z.string(),
	/** sha256 (lowercase hex) over the module's canonical file list; see docs/MODULES.md. */
	contentHash: z.string(),
})

/** `baka.lock.json`: the pins a project insists on, keyed by module id. */
export const BakaLockSchema = z.object({
	lockfileVersion: z.literal(1),
	modules: z.record(z.object({ version: z.string(), contentHash: z.string() })),
})

export const ActionResultSchema = z.object({
	ok: z.boolean(),
	module: z.string(),
	action: z.string(),
	/** Error diagnostics (a failed run carries one whose `rule` is an ActionErrorCode) plus validator output. */
	diagnostics: z.array(ValidationDiagnosticSchema),
	changeset: z.array(ChangesetEntrySchema),
	/** sha256 over the canonical (path, contentHash) list of the changeset; see docs/MODULES.md. */
	outputTreeHash: z.string(),
	/** The module this run used, as resolved. Empty when the module could not be resolved. */
	pins: z.array(ModulePinSchema),
	slots: z.array(SlotRecordSchema),
	compensation: ActionCompensationSchema,
	/** What the action's `execute` returned (side-effect actions); null for template-only actions. */
	output: z.unknown(),
	dryRun: z.boolean(),
})
