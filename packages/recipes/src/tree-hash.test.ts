import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	diffSnapshots,
	outputTreeHash,
	PACK_HASH_DOMAIN,
	packContentHash,
	sha256Hex,
	snapshotTree,
	TREE_HASH_DOMAIN,
} from "./tree-hash.js"

const cleanup: string[] = []
afterEach(() => {
	for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
})

const sha = (s: string) => createHash("sha256").update(s).digest("hex")

describe("the hash domain tags", () => {
	it("are the exported strings the digests are built from, so a consumer never re-declares them", () => {
		expect(outputTreeHash([])).toBe(sha(`${TREE_HASH_DOMAIN}\n`))
		expect(packContentHash).toBeTypeOf("function")
		expect(PACK_HASH_DOMAIN).toBe("baka.pack.v1")
		expect(TREE_HASH_DOMAIN).toBe("workspace.tree.v1")
	})
})

describe("outputTreeHash", () => {
	it("is sha256 over `workspace.tree.v1\\n` then one `<path>\\0<hash>\\n` line per entry, sorted by path", () => {
		const a = sha("a")
		const b = sha("b")
		const expected = sha(`workspace.tree.v1\nsrc/a.ts\0${a}\nsrc/b.ts\0${b}\n`)
		const entries = [
			{ path: "src/b.ts", contentHash: b },
			{ path: "src/a.ts", contentHash: a },
		]
		expect(outputTreeHash(entries)).toBe(expected)
		expect(outputTreeHash([...entries].reverse())).toBe(expected)
	})

	it("hashes an empty changeset to the domain-tag digest", () => {
		expect(outputTreeHash([])).toBe(sha("workspace.tree.v1\n"))
	})

	it("encodes a deleted file as the literal `deleted`", () => {
		expect(outputTreeHash([{ path: "gone.txt", contentHash: null }])).toBe(
			sha("workspace.tree.v1\ngone.txt\0deleted\n"),
		)
	})

	it("changes when any content hash changes", () => {
		expect(outputTreeHash([{ path: "a", contentHash: sha("1") }])).not.toBe(
			outputTreeHash([{ path: "a", contentHash: sha("2") }]),
		)
	})

	it("orders paths by UTF-8 bytes, not UTF-16 code units", () => {
		// U+FF5E is EF BD 9E in UTF-8 but 0xFF5E in UTF-16; U+1F600 is F0 9F 98 80 in
		// UTF-8 but D83D DE00 in UTF-16. The two orders disagree.
		const bmp = { path: "～", contentHash: sha("x") }
		const astral = { path: "\u{1F600}", contentHash: sha("y") }
		const expected = sha(`workspace.tree.v1\n${bmp.path}\0${bmp.contentHash}\n${astral.path}\0${astral.contentHash}\n`)
		expect(outputTreeHash([astral, bmp])).toBe(expected)
	})
})

describe("sha256Hex", () => {
	it("hashes strings as UTF-8 and bytes as-is", () => {
		expect(sha256Hex("héllo")).toBe(sha("héllo"))
		expect(sha256Hex(Buffer.from("héllo", "utf-8"))).toBe(sha("héllo"))
	})
})

describe("snapshotTree and diffSnapshots", () => {
	it("walks files, skips .git, node_modules, and the root .baka, and diffs create/update/delete", () => {
		const dir = mkdtempSync(join(tmpdir(), "baka-snap-"))
		cleanup.push(dir)
		for (const rel of [
			"keep.txt",
			"edit.txt",
			"drop.txt",
			"deep/er/file.txt",
			".git/HEAD",
			"node_modules/x/i.js",
			".baka/slots/k.json",
		]) {
			mkdirSync(join(dir, rel, ".."), { recursive: true })
			writeFileSync(join(dir, rel), rel)
		}
		symlinkSync("keep.txt", join(dir, "link"))
		const before = snapshotTree(dir)
		expect([...before.keys()].sort()).toEqual(["deep/er/file.txt", "drop.txt", "edit.txt", "keep.txt", "link"])

		writeFileSync(join(dir, "edit.txt"), "edited")
		rmSync(join(dir, "drop.txt"))
		writeFileSync(join(dir, "new.txt"), "new")
		const diff = diffSnapshots(before, snapshotTree(dir))
		expect(diff).toEqual([
			{ path: "drop.txt", op: "delete", contentHash: null },
			{ path: "edit.txt", op: "update", contentHash: sha("edited") },
			{ path: "new.txt", op: "create", contentHash: sha("new") },
		])
	})
})
