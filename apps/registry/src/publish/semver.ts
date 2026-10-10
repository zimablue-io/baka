/**
 * Strict semver validation (architecture §8 decision 18).
 *
 * Publish tags MUST be valid semver — `release-1`, `latest`, `v1`
 * are all rejected at publish time (422). The regex matches the
 * SemVer 2.0.0 grammar with an optional leading `v` (the conventional
 * git tag prefix); pre-release and build metadata are accepted when
 * the version is otherwise semver.
 *
 * The check is intentionally narrow:
 *   - the full SemVer 2.0.0 grammar (incl. pre-release + build) is
 *     `^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$`
 *   - with the leading-`v` prefix: `^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-...)?(?:\+...)?$`
 *
 * The published tag becomes the version string on the pack
 * (`pack_versions.version`); version 1.0.0 and 1.0.0-rc.1 are
 * both valid semver and both should pass.
 */

// Full SemVer 2.0.0 grammar (from semver.org), combined into a single
// regex with an optional leading `v`. Anchored so the WHOLE tag is
// validated, not a prefix.
const STRICT_SEMVER_WITH_OPTIONAL_V =
	/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/**
 * Returns true when `tag` matches the strict semver grammar
 * (with an optional leading `v`). Whitespace and surrounding
 * punctuation are NOT stripped — the caller is responsible for
 * validating the tag field's shape before calling this.
 */
export function isStrictSemver(tag: string): boolean {
	if (typeof tag !== "string" || tag.length === 0) return false
	return STRICT_SEMVER_WITH_OPTIONAL_V.test(tag)
}
