import { describePacks } from "@repo/ast-tooling"
import type { ServerContext } from "../context.js"
import { getPacks } from "../context.js"

/**
 * baka://packs — the pack catalog: every discovered pack with its
 * recipes, param declarations, and JSON Schemas, plus the result schema.
 */
export const PACKS_RESOURCE_URI = "baka://packs" as const

export function listPacksResource(_ctx: ServerContext) {
	return {
		uri: PACKS_RESOURCE_URI,
		name: "baka packs",
		description: "Every baka pack discovered in this project (tree + project + user marketplace scopes).",
		mimeType: "application/json",
	}
}

export function readPacksResource(ctx: ServerContext) {
	// The catalog verbatim: the same document `baka list-packs --json` and GET /v1/packs return.
	const catalog = describePacks(ctx.registry)
	return {
		contents: [
			{
				uri: PACKS_RESOURCE_URI,
				mimeType: "application/json",
				text: JSON.stringify(catalog, null, 2),
			},
		],
	}
}

export function readPackManifestResource(ctx: ServerContext, uri: string) {
	const match = uri.match(/^baka:\/\/pack\/([^/]+)\/manifest$/)
	if (!match) {
		throw new Error(`invalid resource URI: ${uri}`)
	}
	const name = decodeURIComponent(match[1])
	const m = getPacks(ctx).find((x) => x.name === name)
	if (!m) {
		throw new Error(`pack not found: ${name}`)
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
 * URI template string for pack manifests. The host uses it for
 * `resources/templates/list` and to match incoming `resources/read`
 * requests. The MCP SDK wraps this string in a `ResourceTemplate`
 * instance internally; we expose the raw string so server.ts can
 * construct the wrapper with the right callbacks.
 */
export const PACK_MANIFEST_URI_TEMPLATE_STRING = "baka://pack/{name}/manifest" as const

export const PACK_MANIFEST_TEMPLATE_METADATA = {
	name: "pack manifest",
	description: "Full manifest JSON for a single pack. Replace {name} with the pack name.",
	mimeType: "application/json",
} as const
