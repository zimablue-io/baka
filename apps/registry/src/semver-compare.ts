/**
 * Semver ordering for the registry's latest-version pointer
 * (architecture §8 decision 11: "latest pointers follow semver order,
 * never insertion order").
 *
 * The publish endpoint validates every tag against the strict SemVer
 * 2.0.0 grammar (with an optional leading `v` — see `publish/semver.ts`)
 * BEFORE writing the row. Every `module_versions.version` string in
 * the database is therefore a known-valid semver. We do not need to
 * re-validate the inputs here; we only need to compare them.
 *
 * The comparator implements the SemVer 2.0.0 precedence rule
 * (https://semver.org/#spec-item-11):
 *
 *   1. Compare major / minor / patch numerically.
 *      A larger version has higher precedence than a lower one.
 *   2. When major / minor / patch are equal, a version WITH
 *      pre-release identifiers has LOWER precedence than one
 *      without (`1.0.0-alpha < 1.0.0`).
 *   3. Pre-release identifiers are compared left-to-right:
 *      numeric identifiers are compared numerically; alphanumeric
 *      identifiers are compared lexically; numeric always has lower
 *      precedence than alphanumeric at the same position; a larger
 *      set of pre-release fields has higher precedence than a
 *      smaller set when all preceding identifiers are equal.
 *   4. Build metadata (`+...`) is IGNORED for precedence (per the
 *      spec — it has no ordering semantics).
 *
 * The optional leading `v` (the conventional git-tag prefix) is
 * stripped before comparison so `v1.2.3` and `1.2.3` sort to the
 * same position. The publish endpoint writes the tag verbatim into
 * the `version` column, so a published `v1.2.3` and a published
 * `1.2.3` both round-trip correctly.
 *
 * Returns -1 when `a < b`, 0 when equal, +1 when `a > b`. The
 * `Array#sort` callback contract is honored directly: `(a, b) =>
 * compareSemver(a, b)`. Inputs are expected to be valid SemVer strings
 * from the publish validation boundary.
 */

/** Strips a leading `v` or `V` from a semver string. */
function stripV(s: string): string {
	return s.length > 0 && (s[0] === "v" || s[0] === "V") ? s.slice(1) : s
}

/**
 * Splits a stripped semver into `{ core, prerelease, build }`. The
 * core is the three numeric components; pre-release and build are
 * the comma-separated identifier lists (or empty arrays when
 * absent). Identifiers preserve their original form so numeric /
 * alphanumeric comparison can dispatch correctly below.
 */
function splitSemver(s: string): { core: [number, number, number]; prerelease: string[]; build: string[] } {
	const buildIdx = s.indexOf("+")
	const withoutBuild = buildIdx === -1 ? s : s.slice(0, buildIdx)
	const build = buildIdx === -1 ? [] : s.slice(buildIdx + 1).split(".")

	const dashIdx = withoutBuild.indexOf("-")
	const coreStr = dashIdx === -1 ? withoutBuild : withoutBuild.slice(0, dashIdx)
	const prerelease = dashIdx === -1 ? [] : withoutBuild.slice(dashIdx + 1).split(".")

	const coreParts = coreStr.split(".")
	const core: [number, number, number] = [
		Number.parseInt(coreParts[0] ?? "0", 10),
		Number.parseInt(coreParts[1] ?? "0", 10),
		Number.parseInt(coreParts[2] ?? "0", 10),
	]
	return { core, prerelease, build }
}

const isNumericIdent = (s: string): boolean => /^[0-9]+$/.test(s)

/**
 * Compares a single pair of pre-release identifiers per the spec.
 * Numeric identifiers compare numerically; alphanumeric compare
 * lexically (ASCII order); numeric < alphanumeric at the same
 * position; missing identifier < present identifier.
 *
 * Returns -1, 0, or +1.
 */
function comparePrereleaseIdents(a: string, b: string): number {
	const aNum = isNumericIdent(a)
	const bNum = isNumericIdent(b)
	if (aNum && bNum) {
		const an = Number.parseInt(a, 10)
		const bn = Number.parseInt(b, 10)
		return an < bn ? -1 : an > bn ? 1 : 0
	}
	if (aNum) return -1
	if (bNum) return 1
	return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Compares two pre-release identifier lists per the spec. A version
 * without pre-release has higher precedence than one with (so an
 * empty list beats a non-empty list when cores are equal).
 */
function comparePrereleaseLists(a: string[], b: string[]): number {
	if (a.length === 0 && b.length === 0) return 0
	if (a.length === 0) return 1
	if (b.length === 0) return -1
	const len = Math.min(a.length, b.length)
	for (let i = 0; i < len; i++) {
		const cmp = comparePrereleaseIdents(a[i] as string, b[i] as string)
		if (cmp !== 0) return cmp
	}
	// All preceding identifiers equal: longer list has higher precedence.
	return a.length < b.length ? -1 : a.length > b.length ? 1 : 0
}

/**
 * Compares two semver strings. Returns -1, 0, or +1. Build
 * metadata is ignored per the spec.
 *
 * Caller is expected to have validated inputs as strict semver
 * (the publish endpoint does this — see `publish/semver.ts`).
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
	if (a === b) return 0
	const aStripped = stripV(a)
	const bStripped = stripV(b)
	const ap = splitSemver(aStripped)
	const bp = splitSemver(bStripped)
	for (let i = 0; i < 3; i++) {
		const ac = ap.core[i] as number
		const bc = bp.core[i] as number
		if (ac < bc) return -1
		if (ac > bc) return 1
	}
	return comparePrereleaseLists(ap.prerelease, bp.prerelease) as -1 | 0 | 1
}

/**
 * Sorts an array of semver strings in ascending order (lowest
 * first). The original array is NOT mutated. Uses `compareSemver`
 * for the ordering.
 */
export function sortSemverAsc(versions: string[]): string[] {
	return [...versions].sort((a, b) => compareSemver(a, b))
}

/**
 * Returns the highest-precedence version from a list. Empty input
 * returns `null`. Ties are broken by `Array#indexOf` order so the
 * first occurrence wins — the caller can pre-sort by `created_at`
 * to get insertion-order tie-breaking, or pre-sort by something
 * else (e.g. name) to get that.
 */
export function maxSemver(versions: string[]): string | null {
	if (versions.length === 0) return null
	let best = versions[0] as string
	for (let i = 1; i < versions.length; i++) {
		const candidate = versions[i] as string
		if (compareSemver(candidate, best) > 0) best = candidate
	}
	return best
}
