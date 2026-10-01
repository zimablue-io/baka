import { ModuleRegistry } from "@repo/ast-tooling"

export interface CreateRegistryOptions {
	/** The project directory actions write into (a git checkout, a scratch dir, ...). */
	root: string
	/**
	 * Directories that contain `<module-name>/manifest.ts` entries, highest
	 * precedence first. Relative paths resolve against `root`. Only these are
	 * searched: no in-tree `modules/`, no `.baka/modules`, no user marketplace.
	 */
	moduleDirs: readonly string[]
}

/** Build a registry from explicit module directories; never consults `~/.baka`. */
export function createRegistry(options: CreateRegistryOptions): ModuleRegistry {
	return new ModuleRegistry(options.root, { moduleDirs: options.moduleDirs })
}
