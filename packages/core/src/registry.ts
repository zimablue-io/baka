import { PackRegistry } from "@repo/ast-tooling"

export interface CreateRegistryOptions {
	/** The project directory recipes write into (a git checkout, a scratch dir, ...). */
	root: string
	/**
	 * Directories that contain `<pack-name>/manifest.ts` entries, highest
	 * precedence first. Relative paths resolve against `root`. Only these are
	 * searched: no in-tree `packs/`, no `.baka/packs`, no user marketplace.
	 */
	packDirs: readonly string[]
}

/** Build a registry from explicit pack directories; never consults `~/.baka`. */
export function createRegistry(options: CreateRegistryOptions): PackRegistry {
	return new PackRegistry(options.root, { packDirs: options.packDirs })
}
