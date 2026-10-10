// Single source of truth for site-wide constants. Update the brand, the GitHub
// URL, and the doc paths here — not in components.

export const BRAND = "baka" as const
const BRAND_KANJI = "馬鹿" as const

const GITHUB_OWNER = "zimablue-io"
const GITHUB_REPO = "baka"
const GITHUB_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`

export const SITE = {
	brand: BRAND,
	brandKanji: BRAND_KANJI,
	github: {
		owner: GITHUB_OWNER,
		repo: GITHUB_REPO,
		url: GITHUB_URL,
		cloneUrl: `${GITHUB_URL}.git`,
		blobUrl: (path: string): string => `${GITHUB_URL}/blob/main/${path}`,
		treeUrl: (path: string): string => `${GITHUB_URL}/tree/main/${path}`,
	},
	docs: {
		philosophy: "docs/PHILOSOPHY.md",
		packs: "docs/PACKS.md",
		agent: "docs/AGENT.md",
	},
	cli: {
		// The CLI binary name (also the package name).
		name: BRAND,
		// For the "baka pack create <name>" hint in the packs section.
		packCreateHint: (name = "<name>"): string => `${BRAND} pack create ${name}`,
	},
} as const
