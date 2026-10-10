import type { RegistryTier } from "@repo/protocol"
import { cn } from "@/lib/cn"

const STYLES: Record<RegistryTier, string> = {
	official: "border-amber-300/40 bg-amber-300/10 text-amber-200",
	verified: "border-sky-300/40 bg-sky-300/10 text-sky-200",
	"community-screened": "border-emerald-300/40 bg-emerald-300/10 text-emerald-200",
	"community-unverified": "border-neutral-700 bg-neutral-900 text-neutral-300",
}

const LABELS: Record<RegistryTier, string> = {
	official: "official",
	verified: "verified",
	"community-screened": "community · screened",
	"community-unverified": "community · unverified",
}

/**
 * Tier badge — a small, uppercased pill that surfaces the server-attached
 * tier of a pack (architecture §8 decision 9 / 26 / 31). The same
 * component is reused on the catalog list and the pack detail page so
 * the four-tier palette is visually consistent across the landing.
 *
 * The badge is "honest about the verdict": the `community-unverified`
 * variant uses neutral greys (no green/blue/sky colors) so the UI does
 * not imply a screening pass that did not happen. The official /
 * verified badges are warmer because the trust level is server-attached
 * rather than community-assigned.
 */
export function TierBadge({ tier }: { tier: RegistryTier }) {
	return (
		<span
			data-testid="tier-badge"
			data-tier={tier}
			className={cn(
				"inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-xs uppercase tracking-wider",
				STYLES[tier],
			)}
		>
			{LABELS[tier]}
		</span>
	)
}
