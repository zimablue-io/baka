import { PackRegistry, resolvePackDirs } from "@repo/ast-tooling"
import type { PackManifest } from "@repo/protocol"

/**
 * Per-process context for the MCP server. The server is launched once per
 * host session and operates against a single project root. The cwd is
 * captured at startup; every tool call resolves relative paths against it.
 */
export interface ServerContext {
	cwd: string
	/** From `BAKA_PACK_DIRS`, else the project's `.baka/settings.json` `packDirs`: when set, packs come only from these directories. */
	packDirs: string[] | undefined
	registry: PackRegistry
	// Cached discovery result. Re-discovered on first call to
	// `getPacks()`. The registry's internal state is mutated by `discover`,
	// so we just delegate to it.
	discoverDiagnostics: () => ReadonlyArray<{ severity: string; rule: string; message: string }>
}

export function createContext(cwd: string): ServerContext {
	const packDirs = resolvePackDirs({ root: cwd, env: process.env })
	const registry = new PackRegistry(cwd, { packDirs })
	// Eagerly discover on startup so that `tools/list` reflects the on-disk
	// state of the packs directory. If discovery fails (e.g. no packs
	// yet, or a malformed manifest), the registry collects diagnostics
	// instead of throwing; the MCP tools will surface them.
	registry.discover(false)
	return {
		cwd,
		packDirs,
		registry,
		discoverDiagnostics: () => {
			const { diagnostics } = registry.discover(false)
			return diagnostics
		},
	}
}

export function getPacks(ctx: ServerContext): PackManifest[] {
	return ctx.registry.all()
}
