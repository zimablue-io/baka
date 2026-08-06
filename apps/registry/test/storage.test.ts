import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createFilesystemStorage } from "../src/storage"

let storageDir: string

beforeEach(() => {
	storageDir = mkdtempSync(join(tmpdir(), "baka-registry-storage-"))
})

afterEach(() => {
	rmSync(storageDir, { recursive: true, force: true })
})

describe("filesystem storage adapter", () => {
	it("should store bytes under their SHA-256 key", async () => {
		const storage = createFilesystemStorage(storageDir)
		const content = Buffer.from("content-addressed blob")
		const sha256 = createHash("sha256").update(content).digest("hex")

		const stored = await storage.put(content)

		expect(stored).toEqual({ key: sha256, sha256, size: content.byteLength })
	})

	it("should retrieve stored bytes by content key", async () => {
		const storage = createFilesystemStorage(storageDir)
		const content = Buffer.from([0, 1, 2, 127, 128, 255])
		const stored = await storage.put(content)

		const retrieved = await storage.get(stored.key)

		expect(retrieved).toEqual(content)
	})

	it("should stat a stored blob by content key", async () => {
		const storage = createFilesystemStorage(storageDir)
		const content = Buffer.from("metadata")
		const stored = await storage.put(content)

		const metadata = await storage.stat(stored.key)

		expect(metadata).toEqual(stored)
	})

	it("should return null when retrieving a missing content key", async () => {
		const storage = createFilesystemStorage(storageDir)

		expect(await storage.get("0".repeat(64))).toBeNull()
	})

	it("should return null when stating a missing content key", async () => {
		const storage = createFilesystemStorage(storageDir)

		expect(await storage.stat("0".repeat(64))).toBeNull()
	})

	it("should reject non-SHA keys on retrieval", async () => {
		const storage = createFilesystemStorage(storageDir)

		await expect(storage.get("../outside")).rejects.toThrow(/invalid blob key/i)
	})

	it("should reject non-SHA keys on stat", async () => {
		const storage = createFilesystemStorage(storageDir)

		await expect(storage.stat("../outside")).rejects.toThrow(/invalid blob key/i)
	})
})
