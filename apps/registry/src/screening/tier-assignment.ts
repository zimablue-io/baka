import type { PGlite } from "@electric-sql/pglite"

/**
 * Tier assignment (architecture §4.6, decisions 20 + 26 + 30,
 * VAL-SCAN-008 / 009 / 010 / 011 / 018, VAL-CROSS-012 / 013).
 *
 * Tiers are server-attached, NEVER self-declarable. The closed set
 * is fixed by the `modules.tier` CHECK constraint in
 * `migrations/0002_app_schema.sql`:
 *
 *   - `official`             — module is published under the official
 *                              org (decision 26). Bare-name resolution
 *                              and the seed catalog live here. Any
 *                              module under the official scope is
 *                              `official` regardless of screening
 *                              outcome (the org's authority is the
 *                              pin).
 *   - `verified`             — module's `scope/name` matches an
 *                              entry in the `REGISTRY_VERIFIED_MODULES`
 *                              env (decision 20). Applied at boot;
 *                              server-only, no publish parameter
 *                              can produce it.
 *   - `community-screened`   — public module that PASSED all three
 *                              screening layers (static scan +
 *                              sandboxed dry-run + output
 *                              validation). The dry-run layer's
 *                              overall verdict is `screened`.
 *   - `community-unverified` — public module that FAILED screening
 *                              or whose screening did not run, plus
 *                              every org-private module (decision
 *                              30: private-by-default skips
 *                              screening entirely). Still listable,
 *                              clearly badged — the verdict text is
 *                              the honest signal, never hidden.
 *
 * The verdict → tier mapping is applied by the worker inside the
 * `runIngestJobInner` flow (the only place screening verdicts
 * are produced). The `official` and `verified` tiers are set by
 * other paths (publish-endpoint for `official`, boot-time seeder
 * for `verified`) so they survive worker re-runs.
 *
 * The helper is intentionally a single UPDATE statement per
 * transition — the existing `modules.tier` row is the single
 * source of truth on every read surface, and the worker's
 * update is idempotent (a re-run on the same row produces the
 * same tier).
 *
 * Decision 31: screening is embedded in the version-detail
 * JSON as the `screening` field (no separate screening
 * endpoint). Tiers surface on every read path the catalog has
 * — list, detail, version-detail — so an operator or a landing
 * user sees the verdict text alongside the badge.
 */

const TIER_VERIFIED = "verified"
const TIER_COMMUNITY_SCREENED = "community-screened"
const TIER_COMMUNITY_UNVERIFIED = "community-unverified"

/**
 * Updates the module's tier to match the screening verdict
 * (community-screened on a full pass, community-unverified on
 * failure or skip). Called by the worker after the screening
 * record is written so the read surface's tier field reflects
 * the final verdict atomically.
 *
 * Idempotent: a re-run of the same verdict writes the same
 * tier. The function does NOT touch `official` or `verified`
 * modules — those tiers are server-attached by other paths
 * (publish-endpoint, boot-time verified seeder) and the
 * verdict → tier transition only governs the community pair.
 *
 * Why explicit UPDATE per verdict transition: the tier column
 * is the catalog-facing field, and an unscreened public module
 * that previously reached `community-screened` (e.g. an older
 * tag) needs to fall back to `community-unverified` when its
 * new tag fails screening. A read-time derived tier would not
 * be honest about the row's CURRENT state — the row carries
 * the truth, the verdict updates it.
 */
export async function updateModuleTierForVerdict(
	pglite: PGlite,
	moduleId: string,
	verdict: "screened" | "unverified" | "failed",
): Promise<void> {
	const targetTier = verdict === "screened" ? TIER_COMMUNITY_SCREENED : TIER_COMMUNITY_UNVERIFIED
	// The CHECK constraint gates the value; only the community
	// pair is updated here — `official` and `verified` rows are
	// left alone by design.
	await pglite.query(
		`UPDATE modules
		    SET tier = $1,
		        updated_at = NOW()
		  WHERE id = $2
		    AND tier IN ($3, $4)`,
		[targetTier, moduleId, TIER_COMMUNITY_SCREENED, TIER_COMMUNITY_UNVERIFIED],
	)
}

/**
 * Applies the `REGISTRY_VERIFIED_MODULES` env var at boot. The
 * env is a JSON array of `scope/name` strings; each entry
 * pins a single module's tier to `verified`. Already-tombstoned
 * modules are skipped (the verified tier must surface on the
 * read surface, which a tombstone would hide anyway — there's
 * no point marking a tombstone).
 *
 * Idempotent: a re-run against the same data dir leaves
 * already-verified rows alone. A module that was previously
 * `verified` but is no longer in the env retains its `verified`
 * tier on this boot — the seeder does NOT actively unverify,
 * because an operator removing an entry mid-process would
 * otherwise silently downgrade a published module's badge.
 * Operators changing the verified list should restart the
 * binary against a fresh data dir (or manually reset tiers)
 * to make the change effective.
 *
 * Returns the number of entries the seeder applied so the
 * operator log can confirm what the boot did. A malformed env
 * value (invalid JSON, wrong shape, empty scope/name) is
 * reported in `failures` for the operator log; the function
 * never throws on a per-entry error so a single typo cannot
 * block the rest of the list.
 */
export async function applyVerifiedModules(
	pglite: PGlite,
	rawEnv: string | undefined,
): Promise<{ applied: number; failures: Array<{ entry: string; error: string }> }> {
	const applied: number = 0
	const failures: Array<{ entry: string; error: string }> = []
	if (rawEnv === undefined || rawEnv.length === 0) {
		return { applied, failures }
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(rawEnv)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		failures.push({ entry: rawEnv, error: `REGISTRY_VERIFIED_MODULES is not valid JSON: ${message}` })
		return { applied, failures }
	}
	if (!Array.isArray(parsed)) {
		failures.push({
			entry: rawEnv,
			error: "REGISTRY_VERIFIED_MODULES must be a JSON array of scope/name strings",
		})
		return { applied, failures }
	}
	let appliedCount = 0
	for (const entry of parsed) {
		if (typeof entry !== "string" || entry.length === 0) {
			failures.push({ entry: String(entry), error: "entry must be a non-empty string" })
			continue
		}
		const slash = entry.indexOf("/")
		if (slash <= 0 || slash === entry.length - 1) {
			failures.push({
				entry,
				error: "entry must be in 'scope/name' format with non-empty scope and name",
			})
			continue
		}
		const scope = entry.slice(0, slash)
		const name = entry.slice(slash + 1)
		// Idempotent: the UPDATE is a no-op when the row does not
		// exist or is already `verified`. An existing module that
		// does not yet have a published version is fine — the tier
		// surfaces on the catalog list and the next publish keeps
		// the tier pin.
		const result = await pglite.query(
			`UPDATE modules
			    SET tier = $1,
			        updated_at = NOW()
			  WHERE scope = $2 AND name = $3
			    AND removed_at IS NULL`,
			[TIER_VERIFIED, scope, name],
		)
		if (result.affectedRows !== undefined && result.affectedRows > 0) {
			appliedCount++
		}
	}
	return { applied: appliedCount, failures }
}
