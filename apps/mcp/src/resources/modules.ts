import type { ServerContext } from "../context.js"
import { getModules } from "../context.js"

/**
 * baka://modules — list of all discovered modules (one entry per module).
 * The host can read this to populate a "what can I do" panel without
 * triggering full manifest loads.
 */
export const MODULES_RESOURCE_URI = "baka://modules" as const

export function listModulesResource(_ctx: ServerContext) {
	return {
		uri: MODULES_RESOURCE_URI,
		name: "baka modules",
		description: "Every baka module discovered in this project (tree + project + user marketplace scopes).",
		mimeType: "application/json",
	}
}

export function readModulesResource(ctx: ServerContext) {
	const modules = getModules(ctx).map((m) => ({
		name: m.name,
		version: m.version,
		description: m.description,
		actions: m.actions.length,
		uri: `baka://module/${m.name}/manifest`,
	}))
	return {
		contents: [
			{
				uri: MODULES_RESOURCE_URI,
				mimeType: "application/json",
				text: JSON.stringify({ modules }, null, 2),
			},
		],
	}
}

/**
 * baka://module/<name>/manifest — full manifest JSON for one module.
 */
export function moduleManifestUri(name: string): string {
	return `baka://module/${name}/manifest`
}

export function readModuleManifestResource(ctx: ServerContext, uri: string) {
	const match = uri.match(/^baka:\/\/module\/([^/]+)\/manifest$/)
	if (!match) {
		throw new Error(`invalid resource URI: ${uri}`)
	}
	const name = decodeURIComponent(match[1])
	const m = getModules(ctx).find((x) => x.name === name)
	if (!m) {
		throw new Error(`module not found: ${name}`)
	}
	return {
		contents: [
			{
				uri,
				mimeType: "application/json",
				text: JSON.stringify(m, null, 2),
			},
		],
	}
}

/**
 * URI template string for module manifests. The host uses it for
 * `resources/templates/list` and to match incoming `resources/read`
 * requests. The MCP SDK wraps this string in a `ResourceTemplate`
 * instance internally; we expose the raw string so server.ts can
 * construct the wrapper with the right callbacks.
 */
export const MODULE_MANIFEST_URI_TEMPLATE_STRING = "baka://module/{name}/manifest" as const

export const MODULE_MANIFEST_TEMPLATE_METADATA = {
	name: "module manifest",
	description: "Full manifest JSON for a single module. Replace {name} with the module name.",
	mimeType: "application/json",
} as const

// Keep the old constant name as an alias for any external consumers.
/** @lintignore Kept as a backwards-compat alias for MODULE_MANIFEST_TEMPLATE_METADATA. */
export const MODULE_MANIFEST_TEMPLATE = {
	uriTemplate: MODULE_MANIFEST_URI_TEMPLATE_STRING,
	...MODULE_MANIFEST_TEMPLATE_METADATA,
} as const
