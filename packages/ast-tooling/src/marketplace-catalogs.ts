import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { BAKA_USER_DIR } from "@repo/protocol"

/**
 * Per-user subscription list for community marketplace catalogs.
 *
 * Stored at `~/.baka/catalogs.json` (overridable via the
 * `path` argument for tests). The CLI's `baka marketplace add/remove/list`
 * commands read and write this file. The marketplace backend treats the
 * URLs in this file as `community`-tier when serving `/v1/modules/:name`
 * and `/v1/aggregate`.
 *
 * Mirrors the pattern of `package-manager.ts`'s `BakaSettings` for
 * project/user scope settings, but kept separate because catalogs are
 * an end-user preference (not a project setting).
 */

export interface CatalogSubscriptions {
	catalogs: string[]
}

export function userCatalogsPath(): string {
	return join(homedir(), `.${BAKA_USER_DIR}`, "catalogs.json")
}

export function readCatalogSubscriptions(path: string = userCatalogsPath()): CatalogSubscriptions {
	if (!existsSync(path)) return { catalogs: [] }
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as CatalogSubscriptions
		if (!Array.isArray(raw.catalogs)) return { catalogs: [] }
		// Normalize: only http(s) URLs.
		const valid = raw.catalogs.filter((u) => typeof u === "string" && /^https?:\/\//.test(u))
		return { catalogs: valid }
	} catch {
		return { catalogs: [] }
	}
}

export function writeCatalogSubscriptions(subs: CatalogSubscriptions, path: string = userCatalogsPath()): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, `${JSON.stringify(subs, null, "\t")}\n`, "utf-8")
}

export function addCatalogSubscription(url: string, path: string = userCatalogsPath()): boolean {
	if (!/^https?:\/\//.test(url)) {
		throw new Error(`catalog URL must be http(s): ${url}`)
	}
	const subs = readCatalogSubscriptions(path)
	if (subs.catalogs.includes(url)) return false
	subs.catalogs.push(url)
	writeCatalogSubscriptions(subs, path)
	return true
}

export function removeCatalogSubscription(url: string, path: string = userCatalogsPath()): boolean {
	const subs = readCatalogSubscriptions(path)
	const idx = subs.catalogs.indexOf(url)
	if (idx === -1) return false
	subs.catalogs.splice(idx, 1)
	writeCatalogSubscriptions(subs, path)
	return true
}
