import builtInData from "../data/built-in.json" with { type: "json" }
import verifiedData from "../data/verified.json" with { type: "json" }
import { type Catalog, CatalogSchema, type VerifiedResponse, VerifiedResponseSchema } from "./schema"

/**
 * Loads and validates the in-repo data files at module load time.
 *
 * The data files are committed to git. CI validates them on every PR; this
 * function validates them again at runtime as a defense-in-depth measure.
 * A malformed `built-in.json` is a programming error (the file is shipped
 * with the engine), so we throw on failure rather than degrade silently.
 */

let cachedBuiltIn: Catalog | null = null
let cachedVerified: VerifiedResponse | null = null

export function getBuiltInCatalog(): Catalog {
	if (cachedBuiltIn) return cachedBuiltIn
	const parsed = CatalogSchema.safeParse(builtInData)
	if (!parsed.success) {
		throw new Error(
			`built-in.json is malformed: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
		)
	}
	cachedBuiltIn = parsed.data
	return cachedBuiltIn
}

export function getVerifiedList(): VerifiedResponse {
	if (cachedVerified) return cachedVerified
	const parsed = VerifiedResponseSchema.safeParse(verifiedData)
	if (!parsed.success) {
		throw new Error(
			`verified.json is malformed: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
		)
	}
	cachedVerified = parsed.data
	return cachedVerified
}
