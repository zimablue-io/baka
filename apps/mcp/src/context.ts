import { findBundledPacks } from "@baka/engine"
import { isolatedFromEnv, llmCallFromEnv } from "@repo/agent-engine"
import { PackRegistry, resolvePackDirs } from "@repo/ast-tooling"
import type { BakaAddon, LlmCall, PackManifest } from "@repo/protocol"

/**
 * Per-process context for the MCP server. The server is launched once per
 * host session and operates against a single project root. The cwd is
 * captured at startup; every tool call resolves relative paths against it.
 */
export interface ServerContext {
	cwd: string
	/** From `BAKA_PACK_DIRS`, else the project's `.baka/settings.json` `packDirs`: when set, packs come only from these directories. */
	packDirs: string[] | undefined
	/** `BAKA_ISOLATED=1`: nothing is read from the user directory. */
	isolated: boolean
	/** The model the host launched this server with (`BAKA_LLM_*`), if any. */
	llm: LlmCall | undefined
	/** The packs that ship with this install. */
	bundledPacksDir: string | undefined
	addons: BakaAddon[]
	registry: PackRegistry
	// Cached discovery result. Re-discovered on first call to
	// `getPacks()`. The registry's internal state is mutated by `discover`,
	// so we just delegate to it.
	discoverDiagnostics: () => ReadonlyArray<{ severity: string; rule: string; message: string }>
}

export function createContext(cwd: string, addons: BakaAddon[] = []): ServerContext {
	const packDirs = resolvePackDirs({ root: cwd, env: process.env })
	const isolated = isolatedFromEnv(process.env)
	const bundledPacksDir = findBundledPacks(import.meta.url)
	const registry = new PackRegistry(cwd, { packDirs, userScope: !isolated, bundledDir: bundledPacksDir })
	// Eagerly discover on startup so that `tools/list` reflects the on-disk
	// state of the packs directory. If discovery fails (e.g. no packs
	// yet, or a malformed manifest), the registry collects diagnostics
	// instead of throwing; the MCP tools will surface them.
	registry.discover(false)
	return {
		cwd,
		packDirs,
		isolated,
		llm: llmCallFromEnv(process.env),
		bundledPacksDir,
		addons,
		registry,
		discoverDiagnostics: () => {
			const { diagnostics } = registry.discover(false)
			return diagnostics
		},
	}
}

/** What every engine call of this server is made with: the host's launch environment decides, per server. */
export function engineOptions(ctx: ServerContext) {
	return {
		packDirs: ctx.packDirs,
		isolated: ctx.isolated,
		llm: ctx.llm,
		bundledPacksDir: ctx.bundledPacksDir,
		addons: ctx.addons,
	}
}

export function getPacks(ctx: ServerContext): PackManifest[] {
	return ctx.registry.all()
}
