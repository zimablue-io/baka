/**
 * Content-addressed storage adapter (architecture §4.1, §4.5).
 *
 * The registry's artifact pipeline (tarballs, previews) needs a backend
 * that can store opaque bytes keyed by their content hash, retrieve them
 * later, and report their size — without leaking the backend shape into
 * the DB schema. The `StorageAdapter` interface is the contract every
 * backend implements; the `artifacts` table stores the key verbatim
 * (see `src/db/schema.ts`), so swapping the filesystem implementation
 * for an S3-compatible client does not require a schema change.
 *
 * v1 ships `createFilesystemStorage` only; the interface exists so the
 * next iteration (hosted hub) can land an `S3Storage` without
 * re-plumbing every consumer.
 */
import { createHash } from "node:crypto"
import { stat as fsStat, mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

export interface StoredBlob {
	key: string
	sha256: string
	size: number
}

export interface StorageAdapter {
	put(content: Uint8Array): Promise<StoredBlob>
	get(key: string): Promise<Uint8Array | null>
	stat(key: string): Promise<StoredBlob | null>
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code
}

function assertBlobKey(key: string): void {
	if (!/^[a-f0-9]{64}$/.test(key)) {
		throw new Error("invalid blob key: expected a lowercase SHA-256 hash")
	}
}

export function createFilesystemStorage(storageDir: string): StorageAdapter {
	const rootDir = resolve(storageDir)

	return {
		async put(content: Uint8Array): Promise<StoredBlob> {
			const bytes = Buffer.from(content)
			const sha256 = createHash("sha256").update(bytes).digest("hex")
			await mkdir(rootDir, { recursive: true })
			try {
				await writeFile(join(rootDir, sha256), bytes, { flag: "wx" })
			} catch (error) {
				if (!hasErrorCode(error, "EEXIST")) throw error
			}
			return { key: sha256, sha256, size: bytes.byteLength }
		},
		async get(key: string): Promise<Uint8Array | null> {
			assertBlobKey(key)
			try {
				return await readFile(join(rootDir, key))
			} catch (error) {
				if (hasErrorCode(error, "ENOENT")) return null
				throw error
			}
		},
		async stat(key: string): Promise<StoredBlob | null> {
			assertBlobKey(key)
			try {
				const metadata = await fsStat(join(rootDir, key))
				return { key, sha256: key, size: metadata.size }
			} catch (error) {
				if (hasErrorCode(error, "ENOENT")) return null
				throw error
			}
		},
	}
}
