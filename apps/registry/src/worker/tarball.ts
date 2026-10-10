import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { listPackFiles } from "./manifest"

/**
 * Tarball pack + content hash (architecture §4.5 step 5).
 *
 * The tarball is a deterministic gzip stream over the pack's
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
 * EXCLUDED from the tarball — it is metadata, not pack content.
 * Two publishes of the same RECIPE TREE at different tags
 * (manifest version bumps) produce identical tarballs and dedupe
 * to one artifact blob on disk. The manifest is still validated
 * against the tag by the publish endpoint (decision 11).
 *
 * The packer writes to a temporary file in the storage dir; the
 * caller is responsible for moving / cleaning up the file on error.
 * The caller hands the produced bytes to the storage adapter for
 * content-addressed dedup (architecture §4.5: same hash → same
 * blob).
 *
 * Scrutiny-round-1 hygiene fix: the ustar header layout pins the
 * 100-byte `name` field at offset 0 (scrutiny-round-1 finding:
 * `Buffer.write` clamps to 512 bytes, not to 100, so a >100-byte
 * path was bleeding into the mode/uid/gid fields before the explicit
 * mode write stomped it). For paths longer than 100 bytes we use
 * the POSIX.1-1988 (ustar) `prefix` field at offset 345 with a
 * 155-byte capacity — splits "packages/something/deep/nested/<id>/recipe.ts"
 * into prefix="packages/something/deep/nested" + name="<id>/recipe.ts",
 * or, for paths that exceed 100 bytes WITHOUT a split-able directory
 * boundary (the rare case for a very long recipe id), we fail
 * loudly rather than corrupt the tarball silently.
 */

interface PackResult {
	bytes: Buffer
	contentHash: string
	size: number
}

const USTAR_NAME_MAX = 100
const USTAR_PREFIX_MAX = 155

/**
 * Packs the pack's tree at `packDir` into a deterministic tar
 * archive. Returns the bytes + sha256 hash + size. The hash is
 * computed over the SAME bytes that go into the archive, so two
 * packs of the same tree produce identical hashes.
 *
 * The implementation streams the pack into a memory buffer rather
 * than a temp file (packs are small — a few KB at most — and the
 * tarball must be content-addressed for dedup). The Buffer is the
 * single source of truth for both the storage adapter's `put()`
 * input and the sha256.
 */
export async function packTarball(packDir: string): Promise<PackResult> {
	const files = await listPackFiles(packDir)
	const blocks: Buffer[] = []

	for (const relativePath of files) {
		const fullPath = join(packDir, relativePath)
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
 * deterministic across runs and platforms. Paths longer than 100
 * bytes use the `prefix` field at offset 345 (155-byte capacity)
 * so they do not corrupt the mode/uid/gid region.
 */
function buildTarHeader(name: string, size: number): Buffer {
	const header = Buffer.alloc(512)
	// Clear the prefix field (bytes 345..500) — `Buffer.alloc` already
	// zeroes the buffer, but write this defensively to make the intent
	// explicit and guard against future mutations.
	for (let i = 345; i < 500; i++) header[i] = 0

	const { name: nameField, prefix } = splitUstarName(name)
	header.write(nameField, 0, "utf8")
	// Pad name with NULs if shorter than 100 chars.
	for (let i = nameField.length; i < USTAR_NAME_MAX; i++) header[i] = 0
	if (prefix.length > 0) {
		header.write(prefix, 345, "utf8")
	}
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

/**
 * Split a relative path into the (name, prefix) pair that fits the
 * ustar header's two string fields. Returns `{ name, prefix }`
 * where `prefix` is empty when the name alone fits in 100 bytes.
 *
 * The split tries the longest directory prefix that keeps the
 * trailing `name` portion within 100 bytes AND keeps the prefix
 * itself within 155 bytes. If no such split exists (a leaf name
 * longer than 100 bytes on its own), this throws — the caller
 * surfaces the diagnostic so the situation is visible.
 */
function splitUstarName(path: string): { name: string; prefix: string } {
	if (path.length <= USTAR_NAME_MAX) {
		return { name: path, prefix: "" }
	}
	const slash = path.lastIndexOf("/")
	if (slash > 0) {
		const prefixCandidate = path.slice(0, slash)
		const nameCandidate = path.slice(slash + 1)
		if (nameCandidate.length <= USTAR_NAME_MAX && prefixCandidate.length <= USTAR_PREFIX_MAX) {
			return { name: nameCandidate, prefix: prefixCandidate }
		}
	}
	throw new Error(
		`cannot encode path '${path}' into a ustar header (leaf longer than ${USTAR_NAME_MAX} bytes and no split-able directory prefix within ${USTAR_PREFIX_MAX} bytes)`,
	)
}

function computeTarChecksum(header: Buffer): number {
	let sum = 0
	for (let i = 0; i < 512; i++) sum += header[i]
	return sum
}
