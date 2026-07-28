import { BUILT_IN_CATALOG, type Catalog, type VerifiedResponse, VerifiedResponseSchema } from "@repo/protocol"
import verifiedData from "../data/verified.json" with { type: "json" }

/**
 * Serves the catalog data at module load time.
 *
 * The built-in catalog lives in `@repo/protocol` (the single source of
 * truth, validated there at module load). `verified.json` is committed to
 * git and validated here at runtime as a defense-in-depth measure; a
 * malformed file is a programming error, so we throw on failure rather
 * than degrade silently.
 */

let cachedVerified: VerifiedResponse | null = null

export function getBuiltInCatalog(): Catalog {
	return BUILT_IN_CATALOG
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
