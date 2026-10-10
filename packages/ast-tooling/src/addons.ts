import { createRequire } from "node:module"
import { delimiter, isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { BakaAddon } from "@repo/protocol"

/** An add-on named by a caller could not be loaded; the message names it and says why. */
export class AddonLoadError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = "AddonLoadError"
	}
}

/** The add-ons a host launched Baka with: `BAKA_ADDONS`, module paths or package names separated like `PATH`. */
export function addonSpecsFromEnv(env: Record<string, string | undefined>): string[] {
	return (env.BAKA_ADDONS ?? "").split(delimiter).filter((spec) => spec.trim().length > 0)
}

function isAddon(value: unknown): value is BakaAddon {
	return typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string"
}

/**
 * Loads add-ons the caller named. Each spec is a path (relative ones resolve against `base`) or the
 * name of a package installed under `base`. The module's default export is the add-on, or a function
 * (sync or async) that returns it. Nothing is loaded that the caller did not name.
 */
export async function loadAddons(specs: readonly string[], base: string): Promise<BakaAddon[]> {
	const loaded: BakaAddon[] = []
	for (const spec of specs) {
		const isPath = spec.startsWith(".") || isAbsolute(spec)
		let exported: unknown
		try {
			const file = isPath ? resolve(base, spec) : createRequire(resolve(base, "noop.js")).resolve(spec)
			const mod = (await import(pathToFileURL(file).href)) as { default?: unknown }
			exported = typeof mod.default === "function" ? await (mod.default as () => unknown)() : mod.default
		} catch (err) {
			throw new AddonLoadError(
				`add-on "${spec}" could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
				{
					cause: err,
				},
			)
		}
		if (!isAddon(exported)) {
			throw new AddonLoadError(`add-on "${spec}" does not export an add-on: its default export needs a string \`name\``)
		}
		loaded.push(exported)
	}
	return loaded
}
