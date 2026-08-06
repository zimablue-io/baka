import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { listModuleFiles } from "./manifest"

/**
 * Tarball pack + content hash (architecture §4.5 step 5).
 *
 * The tarball is a deterministic gzip stream over the module's
 * files in canonical order. The content hash is computed
 * incrementally over the SAME bytes that go into the tarball, so
 * two versions of the same tree produce identical hashes and
 * storage keys regardless of the platform's file ordering.
 *
 * Output bytes:
 *   - tar header per file (POSIX ustar with explicit mtime=0 and
 *     uid/gid=0 so the archive is byte-identical across runs and
 *     platforms).
 *   - file content
 *   - 1024-byte zero blocks at EOF (POSIX requirement)
 *
 * The manifest file (`manifest.ts` or `manifest.json`) is
 * EXCLUDED from the tarball — it is metadata, not module content.
 * Two publishes of the same ACTION TREE at different tags
 * (manifest version bumps) produce identical tarballs and dedupe
 * to one artifact blob on disk. The manifest is still validated
 * against the tag by the publish endpoint (decision 11).
 *
 * The packer writes to a temporary file in the storage dir; the
 * caller is responsible for moving / cleaning up the file on error.
 * The caller hands the produced bytes to the storage adapter for
 * content-addressed dedup (architecture §4.5: same hash → same
 * blob).
 */

interface PackResult {
	bytes: Buffer
	contentHash: string
	size: number
}

/**
 * Packs the module's tree at `moduleDir` into a deterministic tar
 * archive. Returns the bytes + sha256 hash + size. The hash is
 * computed over the SAME bytes that go into the archive, so two
 * packs of the same tree produce identical hashes.
 *
 * The implementation streams the pack into a memory buffer rather
 * than a temp file (modules are small — a few KB at most — and the
 * tarball must be content-addressed for dedup). The Buffer is the
 * single source of truth for both the storage adapter's `put()`
 * input and the sha256.
 */
export async function packTarball(moduleDir: string): Promise<PackResult> {
	const files = await listModuleFiles(moduleDir)
	const blocks: Buffer[] = []

	for (const relativePath of files) {
		const fullPath = join(moduleDir, relativePath)
		const content = await readFile(fullPath)
		const header = buildTarHeader(relativePath, content.byteLength)
		blocks.push(header)
		blocks.push(content)
		const padding = (512 - (content.byteLength % 512)) % 512
		if (padding > 0) blocks.push(Buffer.alloc(padding))
	}

	// Two 512-byte zero blocks at EOF — POSIX tar terminator.
	blocks.push(Buffer.alloc(1024))

	const bytes = Buffer.concat(blocks)
	const contentHash = createHash("sha256").update(bytes).digest("hex")
	return { bytes, contentHash, size: bytes.byteLength }
}

/**
 * Builds a POSIX ustar header for the given file path + length.
 * mtime, uid, and gid are pinned to 0 so the archive is
 * deterministic across runs and platforms.
 */
function buildTarHeader(name: string, size: number): Buffer {
	const header = Buffer.alloc(512)
	header.write(name, 0, "utf8")
	// Pad name with NULs if shorter than 100 chars.
	for (let i = name.length; i < 100; i++) header[i] = 0
	header.write("0000644", 100, "ascii") // file mode
	header.write("0000000", 108, "ascii") // uid
	header.write("0000000", 116, "ascii") // gid
	header.write(size.toString(8).padStart(11, "0"), 124, "ascii")
	header.write("00000000000", 136, "ascii") // mtime
	// Checksum placeholder — eight spaces during calculation.
	for (let i = 148; i < 156; i++) header[i] = 0x20
	header.write("0", 156, "ascii") // type flag: regular file
	header.write("ustar", 257, "ascii") // magic
	header.write("00", 263, "ascii") // version
	const checksum = computeTarChecksum(header)
	header.write(checksum.toString(8).padStart(6, "0"), 148, "ascii")
	header[154] = 0
	header[155] = 0x20
	return header
}

function computeTarChecksum(header: Buffer): number {
	let sum = 0
	for (let i = 0; i < 512; i++) sum += header[i]
	return sum
}
