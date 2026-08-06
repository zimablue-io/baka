import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { extractManifestFields } from "../src/publish/manifest"

/**
 * `extractManifestFields` (scrutiny-round-1 fix #1): the publish-
 * endpoint manifest reader applies the same `..` / absolute-path
 * confinement the worker already enforces (worker/ingest.ts
 * `resolveModuleDir`). A modulePath that would escape the clone
 * dir returns `null`, which the publish endpoint surfaces as a
 * 422 with a field-naming body — never reads or evaluates a
 * manifest outside the cloned repo.
 *
 * The "host file outside the clone dir" cases below prove the
 * guard is active: when the sibling manifest would be reachable
 * by `..`, `extractManifestFields` MUST return null without
 * evaluating it. Without the guard, the sibling manifest's name/
 * version fields would surface.
 */

describe("extractManifestFields — modulePath confinement", () => {
	let dir: string
	let siblingDir: string
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "baka-publish-manifest-"))
		// Sibling at the same level as `dir` so `../sibling` is a
		// valid traversal target. The sibling hosts a valid
		// manifest so that a successful read would be observable.
		siblingDir = mkdtempSync(join(tmpdir(), "baka-publish-manifest-sibling-"))
		writeFileSync(
			join(siblingDir, "manifest.ts"),
			`export default { name: "@attacker/leaked", version: "9.9.9" }`,
			"utf8",
		)
	})
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
		rmSync(siblingDir, { recursive: true, force: true })
	})

	it("rejects a modulePath containing `..` — sibling manifest is NOT read", async () => {
		const result = await extractManifestFields(dir, `../${basename(siblingDir)}`)
		expect(result).toBeNull()
	})

	it("rejects a nested `..` segment like `packages/../../escape`", async () => {
		const escapeDir = mkdtempSync(join(tmpdir(), "baka-publish-manifest-escape-"))
		writeFileSync(
			join(escapeDir, "manifest.ts"),
			`export default { name: "@attacker/nested-escape", version: "9.9.9" }`,
			"utf8",
		)
		try {
			// Place a normal `packages` subdir inside `dir` so the
			// `packages/../../escape` path resolves to the host
			// escape target rather than just failing on missing
			// intermediate.
			require("node:fs").mkdirSync(join(dir, "packages"), { recursive: true })
			const result = await extractManifestFields(dir, `packages/../../${basename(escapeDir)}`)
			expect(result).toBeNull()
		} finally {
			rmSync(escapeDir, { recursive: true, force: true })
		}
	})

	it("rejects an absolute modulePath like `/tmp/<sibling>/manifest`", async () => {
		const result = await extractManifestFields(dir, siblingDir)
		expect(result).toBeNull()
	})

	it("accepts a normal nested modulePath that points at a manifest inside the clone dir", async () => {
		const subdir = join(dir, "packages", "widget")
		require("node:fs").mkdirSync(subdir, { recursive: true })
		writeFileSync(join(subdir, "manifest.ts"), `export default { name: "@acme/widget", version: "1.0.0" }`, "utf8")
		const result = await extractManifestFields(dir, "packages/widget")
		expect(result).not.toBeNull()
		expect(result?.name).toBe("@acme/widget")
		expect(result?.version).toBe("1.0.0")
	})
})

function basename(p: string): string {
	const idx = p.lastIndexOf("/")
	if (idx < 0) return p
	const seg = p.slice(idx + 1)
	return seg.length > 0 ? seg : p
}
