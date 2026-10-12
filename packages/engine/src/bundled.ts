import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The directory of packs that ships with an installed tool, or undefined when there is none.
 *
 * `fromUrl` is the `import.meta.url` of the caller's bundle. An installed build keeps the packs in
 * `packs/` next to its entry file (the build copies them there); a checkout run from source has
 * them at the repository's `packs/`.
 */
export function findBundledPacks(fromUrl: string): string | undefined {
	const here = dirname(fileURLToPath(fromUrl))
	const candidates = [join(here, "packs"), join(here, "..", "..", "..", "packs")]
	return candidates.find((dir) => existsSync(join(dir, "starter", "manifest.ts")))
}
