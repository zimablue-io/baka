import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	addCatalogSubscription,
	readCatalogSubscriptions,
	removeCatalogSubscription,
	writeCatalogSubscriptions,
} from "./marketplace-catalogs"

let tmpDir: string
let catalogsPath: string

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "baka-catalogs-"))
	catalogsPath = join(tmpDir, "catalogs.json")
})

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true })
})

describe("readCatalogSubscriptions", () => {
	it("returns empty when the file does not exist", () => {
		expect(readCatalogSubscriptions(catalogsPath)).toEqual({ catalogs: [] })
	})

	it("returns empty when the file is malformed", () => {
		writeFileSync(catalogsPath, "{ not json", "utf-8")
		expect(readCatalogSubscriptions(catalogsPath)).toEqual({ catalogs: [] })
	})

	it("returns empty when catalogs is not an array", () => {
		writeFileSync(catalogsPath, JSON.stringify({ catalogs: "nope" }), "utf-8")
		expect(readCatalogSubscriptions(catalogsPath)).toEqual({ catalogs: [] })
	})

	it("filters non-http(s) entries", () => {
		writeFileSync(
			catalogsPath,
			JSON.stringify({ catalogs: ["https://ok.com/c.json", "not-a-url", "ftp://bad.com"] }),
			"utf-8",
		)
		expect(readCatalogSubscriptions(catalogsPath)).toEqual({ catalogs: ["https://ok.com/c.json"] })
	})
})

describe("addCatalogSubscription", () => {
	it("adds a new URL", () => {
		expect(addCatalogSubscription("https://a.com/c.json", catalogsPath)).toBe(true)
		expect(readCatalogSubscriptions(catalogsPath)).toEqual({ catalogs: ["https://a.com/c.json"] })
	})

	it("is idempotent (returns false on duplicate)", () => {
		addCatalogSubscription("https://a.com/c.json", catalogsPath)
		expect(addCatalogSubscription("https://a.com/c.json", catalogsPath)).toBe(false)
		expect(readCatalogSubscriptions(catalogsPath)).toEqual({ catalogs: ["https://a.com/c.json"] })
	})

	it("rejects non-http(s) URLs", () => {
		expect(() => addCatalogSubscription("git:foo", catalogsPath)).toThrow(/must be http\(s\)/)
	})
})

describe("removeCatalogSubscription", () => {
	it("removes an existing URL", () => {
		addCatalogSubscription("https://a.com/c.json", catalogsPath)
		addCatalogSubscription("https://b.com/c.json", catalogsPath)
		expect(removeCatalogSubscription("https://a.com/c.json", catalogsPath)).toBe(true)
		expect(readCatalogSubscriptions(catalogsPath)).toEqual({ catalogs: ["https://b.com/c.json"] })
	})

	it("returns false when the URL is not subscribed", () => {
		expect(removeCatalogSubscription("https://nope.com/c.json", catalogsPath)).toBe(false)
	})
})

describe("writeCatalogSubscriptions", () => {
	it("writes the file with a trailing newline", () => {
		writeCatalogSubscriptions({ catalogs: ["https://a.com/c.json"] }, catalogsPath)
		const content = require("node:fs").readFileSync(catalogsPath, "utf-8") as string
		expect(content.endsWith("\n")).toBe(true)
		expect(JSON.parse(content)).toEqual({ catalogs: ["https://a.com/c.json"] })
	})
})
