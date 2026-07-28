import type { Tier } from "@repo/protocol"
import { getVerifiedList } from "./load-data"

/**
 * Determines the trust tier for a given catalog URL.
 *
 * - A URL listed in `verified.json` is `verified` (maintainer-curated).
 * - Anything else is `community` (user-subscribed via the CLI).
 *
 * Note: the `built-in` tier is reserved for the built-in catalog in
 * `@repo/protocol` and never applies to a URL lookup. Built-in modules are
 * served by `/v1/built-in`, not by `/v1/aggregate`.
 */
export function tierForCatalog(url: string): Tier {
	const verified = getVerifiedList()
	if (verified.catalogs.some((c) => c.url === url)) return "verified"
	return "community"
}
