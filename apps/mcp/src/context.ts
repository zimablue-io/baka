import { ModuleRegistry } from "@repo/ast-tooling"
import type { ModuleManifest } from "@repo/protocol"

/**
 * Per-process context for the MCP server. The server is launched once per
 * host session and operates against a single project root. The cwd is
 * captured at startup; every tool call resolves relative paths against it.
 */
export interface ServerContext {
	cwd: string
	registry: ModuleRegistry
	// Cached discovery result. Re-discovered on first call to
	// `getModules()`. The registry's internal state is mutated by `discover`,
	// so we just delegate to it.
	discoverDiagnostics: () => ReadonlyArray<{ severity: string; rule: string; message: string }>
}

export function createContext(cwd: string): ServerContext {
	const registry = new ModuleRegistry(cwd)
	// Eagerly discover on startup so that `tools/list` reflects the on-disk
	// state of the modules directory. If discovery fails (e.g. no modules
	// yet, or a malformed manifest), the registry collects diagnostics
	// instead of throwing; the MCP tools will surface them.
	registry.discover(false)
	return {
		cwd,
		registry,
		discoverDiagnostics: () => {
			const { diagnostics } = registry.discover(false)
			return diagnostics
		},
	}
}

export function getModules(ctx: ServerContext): ModuleManifest[] {
	return ctx.registry.all()
}
