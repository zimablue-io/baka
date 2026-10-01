import { describeModules } from "@repo/ast-tooling"
import type { ServerContext } from "../context.js"
import { getModules } from "../context.js"

/**
 * baka://modules — the module catalog: every discovered module with its
 * actions, param declarations, and JSON Schemas, plus the result schema.
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
	// The catalog verbatim: the same document `baka list-modules --json` and GET /v1/modules return.
	const catalog = describeModules(ctx.registry)
	return {
		contents: [
			{
				uri: MODULES_RESOURCE_URI,
				mimeType: "application/json",
				text: JSON.stringify(catalog, null, 2),
			},
		],
	}
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
