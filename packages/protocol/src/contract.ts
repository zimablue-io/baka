import { z } from "zod"
import type { JsonSchema } from "./json-schema"
import {
	ApiErrorSchema,
	BakaLockSchema,
	LlmCallSchema,
	OpenSlotSchema,
	PackPinSchema,
	PackRecipeParamSchema,
	RecipeResultSchema,
	SlotsInputSchema,
	ValidationDiagnosticSchema,
} from "./schemas"

/**
 * The version of Baka's published contract (docs/CONTRACT.md): the commands, the JSON documents
 * and the exit codes a host may rely on. The major version is also the number at the end of every
 * document id (`baka.receipt/1`). A breaking change raises the major and the ids with it; anything
 * additive raises the minor.
 */
export const BAKA_CONTRACT_VERSION = "1.1.0"

/** The major of {@link BAKA_CONTRACT_VERSION}: what a host asks for with `--require-contract`. */
export const BAKA_CONTRACT_MAJOR = 1

/**
 * What this build can do, by stable name. A host checks the ones it needs before using Baka
 * (`baka version --json --require <name>`). Names are only ever added within a contract major.
 */
export const BAKA_CAPABILITIES = [
	"addons",
	"errors.json",
	"health",
	"isolated",
	"llm.per-call",
	"packs.bundled",
	"packs.dirs",
	"packs.lock",
	"packs.manifest",
	"recipes.bare-name",
	"recipes.dry-run",
	"recipes.run",
	"schemas",
	"serve",
	"slots.open-report",
	"slots.pin",
	"slots.replay",
	"slots.supply",
] as const

export type BakaCapability = (typeof BAKA_CAPABILITIES)[number]

/** `baka version --json`: who answers, which contract it speaks and what it can do. */
export const HandshakeSchema = z.object({
	schema: z.literal("baka.handshake/1"),
	name: z.literal("baka"),
	/** The version of the installed tool (semver). */
	version: z.string(),
	/** The contract version it speaks (semver); the major is the number in the document ids. */
	contract: z.string(),
	capabilities: z.array(z.string()),
	/** The Node.js version it runs on. */
	node: z.string(),
})

export type Handshake = z.infer<typeof HandshakeSchema>

/** `baka health --json`: whether the install can do its job right now. `ok` false goes with exit code 3. */
export const HealthSchema = z.object({
	schema: z.literal("baka.health/1"),
	ok: z.boolean(),
	checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })),
})

export type Health = z.infer<typeof HealthSchema>

const CatalogRecipeSchema = z.object({
	id: z.string(),
	description: z.string(),
	params: z.array(PackRecipeParamSchema),
	/** JSON Schema (draft-07) of `params`, generated from the same schema a run validates against. */
	paramsSchema: z.record(z.string(), z.unknown()),
	requiresReasoning: z.boolean(),
	filePatterns: z.array(z.string()),
	compensatesWith: z.string().optional(),
	format: z.object({ command: z.string(), args: z.array(z.string()) }).optional(),
})

/** `baka list-packs --json`: every pack that can be used, with its recipes and their params. */
export const CatalogDocumentSchema = z.object({
	schema: z.literal("baka.catalog/1"),
	packs: z.array(
		z.object({
			name: z.string(),
			version: z.string(),
			/** The hash a lockfile pins. */
			contentHash: z.string(),
			description: z.string(),
			recipes: z.array(CatalogRecipeSchema),
		}),
	),
	/** JSON Schema (draft-07) of the receipt `baka run` returns. */
	resultSchema: z.record(z.string(), z.unknown()),
	diagnostics: z.array(ValidationDiagnosticSchema),
})

/** `baka slots --json`: the slots a recipe declares, each with the `templateKey` a slot record for it carries. */
export const SlotListSchema = z.object({
	schema: z.literal("baka.slot-list/1"),
	pack: z.string(),
	recipe: z.string(),
	slots: z.array(OpenSlotSchema),
})

/** `GET /v1/recipes/:id/preview`: what a recipe would write, before anything runs. */
export const PreviewSchema = z.object({
	schema: z.literal("baka.preview/1"),
	pack: z.string(),
	recipe: z.string(),
	description: z.string(),
	params: z.array(PackRecipeParamSchema),
	requiresReasoning: z.boolean(),
	filePatterns: z.array(z.string()),
	files: z.array(
		z.object({ rel: z.string(), source: z.string(), when: z.string().optional(), mode: z.string().optional() }),
	),
	slots: z.array(OpenSlotSchema),
})

/** `baka fill --json`: a slot value pinned in the project's slot cache. */
export const FillSchema = z.object({
	schema: z.literal("baka.fill/1"),
	ok: z.literal(true),
	slot: z.string(),
	cachePath: z.string(),
	key: z.string(),
})

/** Every document of the contract, by id. The id is the document's name and its major version. */
export const CONTRACT_DOCUMENTS = {
	"baka.receipt/1": RecipeResultSchema,
	"baka.pin/1": PackPinSchema,
	"baka.lock/1": BakaLockSchema,
	"baka.catalog/1": CatalogDocumentSchema,
	"baka.slot-list/1": SlotListSchema,
	"baka.preview/1": PreviewSchema,
	"baka.fill/1": FillSchema,
	"baka.slots-input/1": SlotsInputSchema,
	"baka.llm-call/1": LlmCallSchema,
	"baka.error/1": ApiErrorSchema,
	"baka.handshake/1": HandshakeSchema,
	"baka.health/1": HealthSchema,
} as const

export type ContractDocumentId = keyof typeof CONTRACT_DOCUMENTS

export const CONTRACT_DOCUMENT_IDS = Object.keys(CONTRACT_DOCUMENTS) as ContractDocumentId[]

export function isContractDocumentId(id: string): id is ContractDocumentId {
	return Object.hasOwn(CONTRACT_DOCUMENTS, id)
}

/**
 * The JSON Schema (draft-07) of one contract document. It carries its own id and a title, and stands
 * alone (nothing refers to another file).
 */
export function contractJsonSchema(id: ContractDocumentId): JsonSchema {
	// `reused: "inline"` inlines every subschema, so the document stands alone with nothing referring to another file.
	const schema = z.toJSONSchema(CONTRACT_DOCUMENTS[id], {
		target: "draft-07",
		reused: "inline",
		io: "input",
	}) as JsonSchema
	return { $id: `https://baka.dev/schemas/${id}`, title: id, ...schema }
}

/** What a host needs from this build before it uses it. */
export interface CompatibilityRequest {
	/** The contract major the host was written against. */
	contract?: number
	/** Capability names the host relies on. */
	capabilities?: readonly string[]
}

/**
 * Why this build does not meet a host's needs, as the contract's error document; null when it does.
 * A different contract major is incompatible by definition; a missing capability names the ones missing.
 */
export function incompatibility(request: CompatibilityRequest): z.infer<typeof ApiErrorSchema> | null {
	if (request.contract !== undefined && request.contract !== BAKA_CONTRACT_MAJOR) {
		return {
			error: {
				code: "incompatible",
				message: `this baka speaks contract ${BAKA_CONTRACT_VERSION}, and the caller needs contract ${request.contract}`,
				hint:
					request.contract > BAKA_CONTRACT_MAJOR
						? "Upgrade baka."
						: "This baka is newer than the caller expects; upgrade the caller or install an older baka.",
			},
		}
	}
	const missing = (request.capabilities ?? []).filter(
		(name) => !(BAKA_CAPABILITIES as readonly string[]).includes(name),
	)
	if (missing.length > 0) {
		return {
			error: {
				code: "incompatible",
				message: `this baka lacks ${missing.length === 1 ? "a capability" : "capabilities"} the caller needs: ${missing.join(", ")}`,
				hint: "Upgrade baka, or run `baka version --json` to list what this install can do.",
			},
		}
	}
	return null
}
