import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { AddonLoadError, addonSpecsFromEnv, loadAddons } from "./addons.js"

const dirs: string[] = []
function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "baka-addons-"))
	dirs.push(dir)
	return dir
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("addonSpecsFromEnv", () => {
	it("splits BAKA_ADDONS on the path delimiter and ignores blanks", () => {
		expect(addonSpecsFromEnv({ BAKA_ADDONS: `./a.mjs${delimiter}${delimiter}@acme/team` })).toEqual([
			"./a.mjs",
			"@acme/team",
		])
		expect(addonSpecsFromEnv({})).toEqual([])
	})
})

describe("loadAddons", () => {
	it("loads a module whose default export is an add-on, resolving a relative path against the base", async () => {
		const base = tmp()
		writeFileSync(join(base, "audit.mjs"), 'export default { name: "audit", beforeRun() {} }\n')
		const [addon] = await loadAddons(["./audit.mjs"], base)
		expect(addon?.name).toBe("audit")
	})

	it("calls a default-exported factory, async or not", async () => {
		const base = tmp()
		writeFileSync(join(base, "made.mjs"), 'export default async () => ({ name: "made", afterRun() {} })\n')
		const [addon] = await loadAddons([join(base, "made.mjs")], base)
		expect(addon?.name).toBe("made")
	})

	it("loads a package installed under the base", async () => {
		const base = tmp()
		const pkg = join(base, "node_modules", "baka-team")
		mkdirSync(pkg, { recursive: true })
		writeFileSync(join(pkg, "package.json"), '{"name":"baka-team","version":"1.0.0","type":"module","main":"index.js"}')
		writeFileSync(join(pkg, "index.js"), 'export default { name: "team" }\n')
		const [addon] = await loadAddons(["baka-team"], base)
		expect(addon?.name).toBe("team")
	})

	it("names the add-on and the reason when it cannot be loaded", async () => {
		const base = tmp()
		await expect(loadAddons(["./missing.mjs"], base)).rejects.toThrow(AddonLoadError)
		await expect(loadAddons(["./missing.mjs"], base)).rejects.toThrow(/missing\.mjs/)
		writeFileSync(join(base, "bad.mjs"), "export default { nope: true }\n")
		await expect(loadAddons(["./bad.mjs"], base)).rejects.toThrow(/does not export an add-on/)
		writeFileSync(join(base, "throws.mjs"), 'throw new Error("boom")\n')
		await expect(loadAddons(["./throws.mjs"], base)).rejects.toThrow(/boom/)
	})
})
