import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CURRENT_SCHEMA_VERSION, ensureSchemaVersion, readSchemaVersion } from "../src/schema-version"

/**
 * Decision 28: forward-only schema migrations. The data dir records a
 * `schema_version`. An old binary started against a NEWER schema version
 * refuses to boot with an honest error naming the mismatch. Migrations
 * are forward-only.
 *
 * The schema version lives at `<dataDir>/schema_version` as a plain string
 * (one integer per line).
 */

function makeTmpDataDir(): string {
	return mkdtempSync(join(tmpdir(), "baka-registry-schema-version-"))
}

let dataDir: string

beforeEach(() => {
	dataDir = makeTmpDataDir()
})

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true })
})

describe("schema_version", () => {
	it("CURRENT_SCHEMA_VERSION is a positive integer string", () => {
		expect(CURRENT_SCHEMA_VERSION).toMatch(/^\d+$/)
		expect(Number.parseInt(CURRENT_SCHEMA_VERSION, 10)).toBeGreaterThanOrEqual(1)
	})

	describe("readSchemaVersion", () => {
		it("returns null when the data dir has no schema_version file", () => {
			expect(readSchemaVersion(dataDir)).toBeNull()
		})

		it("returns the version when the data dir has a schema_version file", () => {
			writeFileSync(join(dataDir, "schema_version"), "3\n", "utf8")
			expect(readSchemaVersion(dataDir)).toBe("3")
		})

		it("trims whitespace around the version string", () => {
			writeFileSync(join(dataDir, "schema_version"), "  7 \n", "utf8")
			expect(readSchemaVersion(dataDir)).toBe("7")
		})
	})

	describe("ensureSchemaVersion", () => {
		it("writes the current version when the data dir is fresh", () => {
			const result = ensureSchemaVersion(dataDir)
			expect(result).toEqual({ ok: true, version: CURRENT_SCHEMA_VERSION })
			expect(readSchemaVersion(dataDir)).toBe(CURRENT_SCHEMA_VERSION)
		})

		it("proceeds when the existing version equals the current version", () => {
			writeFileSync(join(dataDir, "schema_version"), `${CURRENT_SCHEMA_VERSION}\n`, "utf8")
			const result = ensureSchemaVersion(dataDir)
			expect(result.ok).toBe(true)
		})

		it("refuses to boot when the data dir has a newer version than the binary supports", () => {
			const newerVersion = String(Number.parseInt(CURRENT_SCHEMA_VERSION, 10) + 1)
			writeFileSync(join(dataDir, "schema_version"), `${newerVersion}\n`, "utf8")
			const result = ensureSchemaVersion(dataDir)
			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.error.toLowerCase()).toContain("newer")
				expect(result.error).toContain(newerVersion)
				expect(result.error).toContain(CURRENT_SCHEMA_VERSION)
			}
		})

		it("does NOT modify a newer-versioned data dir (forward-only)", () => {
			const newerVersion = String(Number.parseInt(CURRENT_SCHEMA_VERSION, 10) + 1)
			writeFileSync(join(dataDir, "schema_version"), `${newerVersion}\n`, "utf8")
			ensureSchemaVersion(dataDir)
			expect(readSchemaVersion(dataDir)).toBe(newerVersion)
		})

		it("upgrades an older-versioned data dir in place (forward-only migrations)", () => {
			const olderVersion = String(Number.parseInt(CURRENT_SCHEMA_VERSION, 10) - 1)
			writeFileSync(join(dataDir, "schema_version"), `${olderVersion}\n`, "utf8")
			const result = ensureSchemaVersion(dataDir)
			expect(result.ok).toBe(true)
			expect(readSchemaVersion(dataDir)).toBe(CURRENT_SCHEMA_VERSION)
		})
	})
})
