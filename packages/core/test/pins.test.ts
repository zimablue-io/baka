import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	BAKA_LOCKFILE_NAME,
	createLock,
	createRegistry,
	describeModules,
	readLockfile,
	runAction,
	writeLockfile,
} from "../src/index.js"
import { cleanupTempDirs, fakeProvider, GREET_MODULE, tempDir, writeModule } from "./helpers.js"

afterEach(cleanupTempDirs)

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")
const RUN = { module: "hello", action: "greet", params: { name: "Ada" } }

/** The documented module hash, computed here from the file list rather than imported. */
function expectedModuleHash(files: Record<string, string>): string {
	const lines = Object.keys(files)
		.sort()
		.map((path) => `${path}\0${sha(files[path] ?? "")}\n`)
	return sha(`baka.module.v1\n${lines.join("")}`)
}

function setup(mod = GREET_MODULE) {
	const root = tempDir()
	const modules = tempDir()
	const moduleRoot = writeModule(modules, mod)
	return { root, modules, moduleRoot, registry: createRegistry({ root, moduleDirs: [modules] }) }
}

describe("module pins", () => {
	it("records {id, version, contentHash} for the module a run used", async () => {
		const { registry, moduleRoot } = setup({ ...GREET_MODULE, version: "1.4.2" })
		const result = await runAction({ registry, ...RUN, provider: fakeProvider() })
		const manifest = readFileSync(join(moduleRoot, "manifest.ts"), "utf-8")
		const template = readFileSync(join(moduleRoot, "greet", "templates", "hello.md.hbs"), "utf-8")
		expect(result.pins).toEqual([
			{
				id: "hello",
				version: "1.4.2",
				contentHash: expectedModuleHash({ "manifest.ts": manifest, "greet/templates/hello.md.hbs": template }),
			},
		])
	})

	it("hashes the same module content to the same value wherever it lives", async () => {
		const a = setup()
		const b = setup()
		const ra = await runAction({ registry: a.registry, ...RUN, provider: fakeProvider() })
		const rb = await runAction({ registry: b.registry, ...RUN, provider: fakeProvider() })
		expect(ra.pins).toEqual(rb.pins)
	})

	it("changes when a module file changes, and ignores install and tool residue", async () => {
		const { registry, moduleRoot } = setup()
		const before = (await runAction({ registry, ...RUN, dryRun: true, provider: fakeProvider() })).pins[0]?.contentHash

		mkdirSync(join(moduleRoot, "node_modules", "dep"), { recursive: true })
		writeFileSync(join(moduleRoot, "node_modules", "dep", "index.js"), "x")
		mkdirSync(join(moduleRoot, "greet", "out"), { recursive: true })
		writeFileSync(join(moduleRoot, "greet", "out", "residue.txt"), "x")
		writeFileSync(join(moduleRoot, ".DS_Store"), "x")
		writeFileSync(join(moduleRoot, ".design-state.json"), "{}")
		const withResidue = (await runAction({ registry, ...RUN, dryRun: true, provider: fakeProvider() })).pins[0]
			?.contentHash
		expect(withResidue).toBe(before)

		writeFileSync(join(moduleRoot, "greet", "templates", "hello.md.hbs"), "# changed\n")
		const changed = (await runAction({ registry, ...RUN, dryRun: true, provider: fakeProvider() })).pins[0]?.contentHash
		expect(changed).not.toBe(before)
	})

	it("is listed per module in the catalog, equal to the run's pin", async () => {
		const { registry } = setup()
		const catalog = describeModules(registry)
		const run = await runAction({ registry, ...RUN, dryRun: true, provider: fakeProvider() })
		expect(catalog.modules[0]?.contentHash).toBe(run.pins[0]?.contentHash)
	})

	it("is empty when the module cannot be resolved", async () => {
		const { registry } = setup()
		const result = await runAction({ registry, module: "nope", action: "x", params: {} })
		expect(result.pins).toEqual([])
	})
})

describe("baka.lock.json", () => {
	it("createLock pins every module by id, and a run under that lock passes", async () => {
		const { root, registry } = setup()
		const lock = createLock(registry)
		const pin = (await runAction({ registry, ...RUN, dryRun: true, provider: fakeProvider() })).pins[0]
		expect(lock).toEqual({
			lockfileVersion: 1,
			modules: { hello: { version: "0.1.0", contentHash: pin?.contentHash } },
		})
		const result = await runAction({ registry, ...RUN, lock, provider: fakeProvider() })
		expect(result.ok).toBe(true)
		expect(existsSync(join(root, "hello.md"))).toBe(true)
	})

	it("fails closed, before any model call or write, when a module file changed since the lock", async () => {
		const { root, registry, moduleRoot } = setup()
		const lock = createLock(registry)
		writeFileSync(join(moduleRoot, "greet", "templates", "hello.md.hbs"), "# tampered {{name}}\n")
		const provider = fakeProvider()
		const result = await runAction({ registry, ...RUN, lock, provider })
		expect(result.ok).toBe(false)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["lock-mismatch"])
		expect(result.diagnostics[0]?.message).toContain("contentHash")
		expect(provider.calls).toHaveLength(0)
		expect(readdirSync(root)).toEqual([])
	})

	it("fails with lock-mismatch when the version moved", async () => {
		const { registry } = setup()
		const lock = createLock(registry)
		lock.modules.hello = { version: "0.0.9", contentHash: lock.modules.hello?.contentHash ?? "" }
		const result = await runAction({ registry, ...RUN, lock, provider: fakeProvider() })
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["lock-mismatch"])
		expect(result.diagnostics[0]?.message).toContain("locked at version 0.0.9")
	})

	it("fails with lock-unlisted when the lock does not mention the module", async () => {
		const { registry } = setup()
		const result = await runAction({
			registry,
			...RUN,
			lock: { lockfileVersion: 1, modules: {} },
			provider: fakeProvider(),
		})
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["lock-unlisted"])
	})

	it("can lock a subset of modules", () => {
		const { registry, modules } = setup()
		writeModule(modules, { name: "other", actions: GREET_MODULE.actions })
		expect(Object.keys(createLock(registry).modules)).toEqual(["hello", "other"])
		expect(Object.keys(createLock(registry, ["other"]).modules)).toEqual(["other"])
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
		writeFileSync(path, JSON.stringify({ lockfileVersion: 2, modules: {} }))
		expect(() => readLockfile(root)).toThrow("not a valid baka.lock.json")
	})

	it("is satisfied by a copy of the module elsewhere with identical content", async () => {
		const { registry, moduleRoot } = setup()
		const lock = createLock(registry)
		const elsewhere = tempDir()
		cpSync(moduleRoot, join(elsewhere, "hello"), { recursive: true })
		const other = createRegistry({ root: tempDir(), moduleDirs: [elsewhere] })
		const result = await runAction({ registry: other, ...RUN, lock, provider: fakeProvider() })
		expect(result.ok).toBe(true)
	})
})
