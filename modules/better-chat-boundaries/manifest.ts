import type { ModuleManifest } from "baka-sdk"

/**
 * One boundary rule: a source package may not import a forbidden target.
 *
 * The 11 entries below are byte-for-byte the FORBIDDEN array in
 * `better-chat/scripts/check-boundaries.mjs`. The validation contract's
 * VAL-DOG-003 calls for "12 boundary rules"; see `README.md` for the
 * 11-vs-12 discrepancy and the rationale for not synthesizing a 12th
 * rule the legacy script does not enforce.
 */
export type BoundaryRule = {
	sourcePkg: string
	forbiddenImport: string
}

export const BOUNDARY_RULES: BoundaryRule[] = [
	{ sourcePkg: "packages/ai-media/src", forbiddenImport: "@repo/database" },
	{ sourcePkg: "packages/database/src", forbiddenImport: "@repo/ai-media" },
	{ sourcePkg: "packages/characters/src", forbiddenImport: "@repo/database" },
	{ sourcePkg: "packages/common/src", forbiddenImport: "@repo/database" },
	{ sourcePkg: "packages/common/src", forbiddenImport: "@repo/ai-media" },
	{ sourcePkg: "packages/common/src", forbiddenImport: "@repo/characters" },
	{ sourcePkg: "packages/ui/src", forbiddenImport: "@repo/ai" },
	{ sourcePkg: "packages/auth/src", forbiddenImport: "@repo/ai" },
	{ sourcePkg: "packages/payment/src", forbiddenImport: "@repo/ai" },
	{ sourcePkg: "packages/ai-media/src", forbiddenImport: "@repo/ai-3d" },
	{ sourcePkg: "packages/ai-3d/src", forbiddenImport: "@repo/ai-media" },
]

export const Manifest: ModuleManifest = {
	name: "better-chat-boundaries",
	version: "0.1.0",
	description:
		"Captured boundary-check module for the better-chat monorepo. Runs scripts/check-boundaries.mjs in a sandboxed temp dir against the live source; reports structured pass/fail diagnostics without mutating the live tree.",
	dependencies: [],
	conflictsWith: [],
	actions: [
		{
			id: "validate",
			description:
				"Run the boundary check in a sandboxed temp dir against the live better-chat source. Read-only; never mutates the live tree. Returns pass on clean source and fail with structured {source, forbidden, file, line} diagnostics on injected violations.",
			requiresReasoning: false,
			filePatterns: [],
			validators: [],
			params: [],
		},
	],
	moduleValidators: ["checkBoundaries"],
}
