import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	BAKA_LOCKFILE_NAME,
	createLock,
	createRegistry,
	describePacks,
	readLockfile,
	runRecipe,
	writeLockfile,
} from "../src/index.js"
import { cleanupTempDirs, fakeProvider, GREET_PACK, tempDir, writePack } from "./helpers.js"

afterEach(cleanupTempDirs)

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")
const RUN = { pack: "hello", recipe: "greet", params: { name: "Ada" } }

/** The documented pack hash, computed here from the file list rather than imported. */
function expectedPackHash(files: Record<string, string>): string {
	const lines = Object.keys(files)
		.sort()
		.map((path) => `${path}\0${sha(files[path] ?? "")}\n`)
	return sha(`baka.pack.v1\n${lines.join("")}`)
}

function setup(mod = GREET_PACK) {
	const root = tempDir()
	const packs = tempDir()
	const packRoot = writePack(packs, mod)
	return { root, packs, packRoot, registry: createRegistry({ root, packDirs: [packs] }) }
}

describe("pack pins", () => {
	it("records {id, version, contentHash} for the pack a run used", async () => {
		const { registry, packRoot } = setup({ ...GREET_PACK, version: "1.4.2" })
		const result = await runRecipe({ registry, ...RUN, provider: fakeProvider() })
		const manifest = readFileSync(join(packRoot, "manifest.ts"), "utf-8")
		const template = readFileSync(join(packRoot, "greet", "templates", "hello.md.hbs"), "utf-8")
		expect(result.pins).toEqual([
			{
				id: "hello",
				version: "1.4.2",
				contentHash: expectedPackHash({ "manifest.ts": manifest, "greet/templates/hello.md.hbs": template }),
			},
		])
	})

	it("hashes the same pack content to the same value wherever it lives", async () => {
		const a = setup()
		const b = setup()
		const ra = await runRecipe({ registry: a.registry, ...RUN, provider: fakeProvider() })
		const rb = await runRecipe({ registry: b.registry, ...RUN, provider: fakeProvider() })
		expect(ra.pins).toEqual(rb.pins)
	})

	it("changes when a pack file changes, and ignores install and tool residue", async () => {
		const { registry, packRoot } = setup()
		const before = (await runRecipe({ registry, ...RUN, dryRun: true, provider: fakeProvider() })).pins[0]?.contentHash

		mkdirSync(join(packRoot, "node_modules", "dep"), { recursive: true })
		writeFileSync(join(packRoot, "node_modules", "dep", "index.js"), "x")
		mkdirSync(join(packRoot, "greet", "out"), { recursive: true })
		writeFileSync(join(packRoot, "greet", "out", "residue.txt"), "x")
		writeFileSync(join(packRoot, ".DS_Store"), "x")
		writeFileSync(join(packRoot, ".design-state.json"), "{}")
		const withResidue = (await runRecipe({ registry, ...RUN, dryRun: true, provider: fakeProvider() })).pins[0]
			?.contentHash
		expect(withResidue).toBe(before)

		writeFileSync(join(packRoot, "greet", "templates", "hello.md.hbs"), "# changed\n")
		const changed = (await runRecipe({ registry, ...RUN, dryRun: true, provider: fakeProvider() })).pins[0]?.contentHash
		expect(changed).not.toBe(before)
	})

	it("is listed per pack in the catalog, equal to the run's pin", async () => {
		const { registry } = setup()
		const catalog = describePacks(registry)
		const run = await runRecipe({ registry, ...RUN, dryRun: true, provider: fakeProvider() })
		expect(catalog.packs[0]?.contentHash).toBe(run.pins[0]?.contentHash)
	})

	it("is empty when the pack cannot be resolved", async () => {
		const { registry } = setup()
		const result = await runRecipe({ registry, pack: "nope", recipe: "x", params: {} })
		expect(result.pins).toEqual([])
	})
})

describe("baka.lock.json", () => {
	it("createLock pins every pack by id, and a run under that lock passes", async () => {
		const { root, registry } = setup()
		const lock = createLock(registry)
		const pin = (await runRecipe({ registry, ...RUN, dryRun: true, provider: fakeProvider() })).pins[0]
		expect(lock).toEqual({
			lockfileVersion: 1,
			packs: { hello: { version: "0.1.0", contentHash: pin?.contentHash } },
		})
		const result = await runRecipe({ registry, ...RUN, lock, provider: fakeProvider() })
		expect(result.ok).toBe(true)
		expect(existsSync(join(root, "hello.md"))).toBe(true)
	})

	it("fails closed, before any model call or write, when a pack file changed since the lock", async () => {
		const { root, registry, packRoot } = setup()
		const lock = createLock(registry)
		writeFileSync(join(packRoot, "greet", "templates", "hello.md.hbs"), "# tampered {{name}}\n")
		const provider = fakeProvider()
		const result = await runRecipe({ registry, ...RUN, lock, provider })
		expect(result.ok).toBe(false)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["lock-mismatch"])
		expect(result.diagnostics[0]?.message).toContain("contentHash")
		expect(provider.calls).toHaveLength(0)
		expect(readdirSync(root)).toEqual([])
	})

	it("fails with lock-mismatch when the version moved", async () => {
		const { registry } = setup()
		const lock = createLock(registry)
		lock.packs.hello = { version: "0.0.9", contentHash: lock.packs.hello?.contentHash ?? "" }
		const result = await runRecipe({ registry, ...RUN, lock, provider: fakeProvider() })
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["lock-mismatch"])
		expect(result.diagnostics[0]?.message).toContain("locked at version 0.0.9")
	})

	it("fails with lock-unlisted when the lock does not mention the pack", async () => {
		const { registry } = setup()
		const result = await runRecipe({
			registry,
			...RUN,
			lock: { lockfileVersion: 1, packs: {} },
			provider: fakeProvider(),
		})
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["lock-unlisted"])
	})

	it("can lock a subset of packs", () => {
		const { registry, packs } = setup()
		writePack(packs, { name: "other", recipes: GREET_PACK.recipes })
		expect(Object.keys(createLock(registry).packs)).toEqual(["hello", "other"])
		expect(Object.keys(createLock(registry, ["other"]).packs)).toEqual(["other"])
	})

	it("round-trips through the file, and reports a missing or malformed file", () => {
		const { root, registry } = setup()
		expect(readLockfile(root)).toBeNull()
		const lock = createLock(registry)
		const path = writeLockfile(root, lock)
		expect(path).toBe(join(root, BAKA_LOCKFILE_NAME))
		expect(readFileSync(path, "utf-8").endsWith("\n")).toBe(true)
		expect(readLockfile(root)).toEqual(lock)

		writeFileSync(path, "{ not json")
		expect(() => readLockfile(root)).toThrow("not valid JSON")
		writeFileSync(path, JSON.stringify({ lockfileVersion: 2, packs: {} }))
		expect(() => readLockfile(root)).toThrow("not a valid baka.lock.json")
	})

	it("is satisfied by a copy of the pack elsewhere with identical content", async () => {
		const { registry, packRoot } = setup()
		const lock = createLock(registry)
		const elsewhere = tempDir()
		cpSync(packRoot, join(elsewhere, "hello"), { recursive: true })
		const other = createRegistry({ root: tempDir(), packDirs: [elsewhere] })
		const result = await runRecipe({ registry: other, ...RUN, lock, provider: fakeProvider() })
		expect(result.ok).toBe(true)
	})
})
