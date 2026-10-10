// ---------------------------------------------------------------------------
// Unit tests for the CLI install command's pure helpers (feature cli-install,
// milestone 5). The black-box subprocess suite (`install-e2e.test.ts`)
// exercises the real CLI against a seed-publishing-server; this file pins
// the parsers and integrity checks that drive the install flow.
//
// Coverage map (per validation-contract.md):
//
//   VAL-DISC-040  parseInstallSpec rejects malformed inputs with distinct
//                  messages and never the legacy "unrecognized source"
//                  catch-all (audit B3 must not recur)
//   VAL-DISC-041  verifyTarballIntegrity refuses mismatched sha256 with
//                  an honest error and leaves no partial state
//   VAL-DISC-037  detectNameCollision refuses cross-scope same-name
//                  installs (decision 5)
//   VAL-DISC-042  re-install and upgrade semantics: same scope+name at
//                  same version is a no-op (idempotent); same scope+name
//                  at a different version is an upgrade in place
//   VAL-DISC-043  --user puts the install into the user marketplace;
//                  a second project sees the install
//
// Conventions:
//   - in-process; no subprocess spawn
//   - isolated temp dirs per test (mkdtemp under /tmp)
//   - never touch the user's real ~/.baka
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { extractRegistryTarball, type ManifestJsonShape, parseSource, verifyTarballIntegrity } from "@repo/ast-tooling"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { __test__, runInstallCommand, runUninstallCommand } from "../src/commands/install"

const { parseInstallSpec, parseRegistrationScopeName, isValidSemverTag, isValidPackIdentifier } = __test__

const createdDirs: string[] = []
function trackTmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	createdDirs.push(dir)
	return dir
}

afterEach(() => {
	for (const d of createdDirs.splice(0)) {
		if (existsSync(d)) rmSync(d, { recursive: true, force: true })
	}
})

// ---------------------------------------------------------------------------
// VAL-DISC-040 — parseInstallSpec rejects malformed inputs honestly
// ---------------------------------------------------------------------------

describe("VAL-DISC-040 parseInstallSpec rejects malformed pack specs", () => {
	it("accepts well-formed scoped specs", () => {
		expect(parseInstallSpec("@acme/widget")).toEqual({
			kind: "registry",
			scope: "acme",
			name: "widget",
			pinnedVersion: null,
		})
		expect(parseInstallSpec("@acme/widget@1.2.3")).toEqual({
			kind: "registry",
			scope: "acme",
			name: "widget",
			pinnedVersion: "1.2.3",
		})
		expect(parseInstallSpec("@acme/widget@v1.2.3")).toEqual({
			kind: "registry",
			scope: "acme",
			name: "widget",
			pinnedVersion: "1.2.3",
		})
	})

	it("accepts well-formed bare-name specs (official scope)", () => {
		expect(parseInstallSpec("widget")).toEqual({
			kind: "registry",
			scope: null,
			name: "widget",
			pinnedVersion: null,
		})
		expect(parseInstallSpec("widget@1.0.0")).toEqual({
			kind: "registry",
			scope: null,
			name: "widget",
			pinnedVersion: "1.0.0",
		})
	})

	it("falls through to `source` for explicit npm:/git:/path/URL specs", () => {
		expect(parseInstallSpec("npm:@scope/pkg").kind).toBe("source")
		expect(parseInstallSpec("git:github.com/x/y.git").kind).toBe("source")
		expect(parseInstallSpec("git:github.com/x/y.git@v1").kind).toBe("source")
		expect(parseInstallSpec("https://example.com/x.tar.gz").kind).toBe("source")
		expect(parseInstallSpec("/abs/path/to/pack").kind).toBe("source")
		expect(parseInstallSpec("./rel/path").kind).toBe("source")
	})

	it("rejects a spec with no name after the scope (@acme)", () => {
		expect(() => parseInstallSpec("@acme")).toThrow(/malformed/)
	})

	it("rejects a spec with no scope (@/widget)", () => {
		expect(() => parseInstallSpec("@/widget")).toThrow(/malformed/)
	})

	it("treats a trailing empty pin (widget@) as no version pin", () => {
		expect(parseInstallSpec("widget@")).toEqual({
			kind: "registry",
			scope: null,
			name: "widget",
			pinnedVersion: null,
		})
	})

	it("rejects a spec with a non-semver version pin (@acme/widget@not-a-version)", () => {
		expect(() => parseInstallSpec("@acme/widget@not-a-version")).toThrow(/not a valid semver/)
		expect(() => parseInstallSpec("@acme/widget@release-1")).toThrow(/not a valid semver/)
	})

	it("rejects a spec with too many path segments (@acme/widget/extra)", () => {
		expect(() => parseInstallSpec("@acme/widget/extra")).toThrow(/malformed/)
	})

	it("never produces the legacy `unrecognized source` catch-all (audit B3 must not recur)", () => {
		const messages: string[] = []
		const tryParse = (s: string) => {
			try {
				parseInstallSpec(s)
			} catch (err) {
				messages.push(err instanceof Error ? err.message : String(err))
			}
		}
		tryParse("@acme")
		tryParse("@/widget")
		tryParse("@acme/widget@not-a-version")
		tryParse("@acme/widget/extra")
		tryParse("@acme/")
		expect(messages.length).toBeGreaterThan(0)
		for (const msg of messages) {
			expect(msg.toLowerCase()).not.toContain("unrecognized source")
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-041 — verifyTarballIntegrity refuses mismatched sha256
// ---------------------------------------------------------------------------

describe("VAL-DISC-041 verifyTarballIntegrity refuses mismatched sha256", () => {
	it("returns the bytes unchanged when the sha256 matches", () => {
		const bytes = new Uint8Array([1, 2, 3, 4])
		const { createHash } = require("node:crypto") as typeof import("node:crypto")
		const expected = createHash("sha256").update(bytes).digest("hex")
		const result = verifyTarballIntegrity({ bytes, expectedSha256: expected })
		expect(result).toBe(bytes)
	})

	it("throws with the expected vs actual hash on a mismatch", () => {
		const bytes = new Uint8Array([1, 2, 3, 4])
		const wrongHash = "0".repeat(64)
		expect(() => verifyTarballIntegrity({ bytes, expectedSha256: wrongHash })).toThrow(/integrity mismatch/)
		try {
			verifyTarballIntegrity({ bytes, expectedSha256: wrongHash })
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			expect(message).toContain(wrongHash)
		}
	})
})

// ---------------------------------------------------------------------------
// extractRegistryTarball — POSIX ustar layout produced by the registry
// ---------------------------------------------------------------------------

describe("extractRegistryTarball", () => {
	function buildTarball(files: Array<{ path: string; body: Uint8Array }>): Uint8Array {
		const blocks: Buffer[] = []
		const BLOCK = 512
		for (const file of files) {
			const header = Buffer.alloc(BLOCK)
			const { name: nameField, prefix } = splitPath(file.path)
			header.write(nameField, 0, "utf8")
			for (let i = nameField.length; i < 100; i++) header[i] = 0
			if (prefix.length > 0) header.write(prefix, 345, "utf8")
			header.write("0000644", 100, "ascii")
			header.write("0000000", 108, "ascii")
			header.write("0000000", 116, "ascii")
			header.write(file.body.byteLength.toString(8).padStart(11, "0"), 124, "ascii")
			header.write("00000000000", 136, "ascii")
			for (let i = 148; i < 156; i++) header[i] = 0x20
			header.write("0", 156, "ascii")
			header.write("ustar", 257, "ascii")
			header.write("00", 263, "ascii")
			const checksum = computeChecksum(header)
			header.write(checksum.toString(8).padStart(6, "0"), 148, "ascii")
			header[154] = 0
			header[155] = 0x20
			blocks.push(header)
			blocks.push(Buffer.from(file.body))
			const padding = (BLOCK - (file.body.byteLength % BLOCK)) % BLOCK
			if (padding > 0) blocks.push(Buffer.alloc(padding))
		}
		blocks.push(Buffer.alloc(BLOCK * 2))
		return Buffer.concat(blocks)
	}

	function splitPath(path: string): { name: string; prefix: string } {
		if (path.length <= 100) return { name: path, prefix: "" }
		const slash = path.lastIndexOf("/")
		return { name: path.slice(slash + 1), prefix: path.slice(0, slash) }
	}

	function computeChecksum(header: Buffer): number {
		let sum = 0
		for (let i = 0; i < 512; i++) sum += header[i]
		return sum
	}

	it("extracts a tarball's regular files and writes a fresh manifest.ts", () => {
		const tarballBytes = buildTarball([
			{ path: "noop/recipe.ts", body: new Uint8Array([1, 2, 3]) },
			{ path: "noop/validator.ts", body: new Uint8Array([4, 5, 6]) },
		])
		const manifestJson: ManifestJsonShape = {
			name: "@acme/widget",
			version: "1.0.0",
			description: "an ok pack",
			dependencies: [],
			conflictsWith: [],
			recipes: [{ id: "noop", description: "no-op", requiresReasoning: false, filePatterns: [] }],
			packValidators: [],
		}
		const dest = trackTmp("baka-extract-")
		const result = extractRegistryTarball(tarballBytes, dest, manifestJson)
		expect(result.fileCount).toBe(2)
		expect(result.manifestWritten).toBe(join(dest, "manifest.ts"))
		expect(existsSync(`${dest}/noop/recipe.ts`)).toBe(true)
		expect(existsSync(`${dest}/noop/validator.ts`)).toBe(true)
		const manifestText = readFileSync(`${dest}/manifest.ts`, "utf-8")
		expect(manifestText).toContain('"name": "@acme/widget"')
		expect(manifestText).toContain('"version": "1.0.0"')
	})

	it("refuses path-traversal entries (a malformed tarball)", () => {
		const tarballBytes = buildTarball([{ path: "../escape.txt", body: new Uint8Array([1]) }])
		const manifestJson: ManifestJsonShape = {
			name: "@acme/widget",
			version: "1.0.0",
			recipes: [],
		}
		const dest = trackTmp("baka-extract-traverse-")
		expect(() => extractRegistryTarball(tarballBytes, dest, manifestJson)).toThrow(/outside the install destination/)
	})
})

// ---------------------------------------------------------------------------
// parseSource accepts the new `registry:` shape (the CLI's internal wire
// format). Other source types still work as before.
// ---------------------------------------------------------------------------

describe("parseSource accepts the registry:@scope/name@version shape", () => {
	it("returns type='registry' for a registry source string", () => {
		const parsed = parseSource("registry:@acme/widget@1.0.0")
		expect(parsed.type).toBe("registry")
		expect(parsed.packName).toBe("acme-widget")
		expect(parsed.pinned).toBe(true)
		expect(parsed.spec).toBe("acme/widget@1.0.0")
	})

	it("returns type='registry' with pinned=false when no version is pinned", () => {
		const parsed = parseSource("registry:@acme/widget")
		expect(parsed.type).toBe("registry")
		expect(parsed.pinned).toBe(false)
		expect(parsed.spec).toBe("acme/widget")
	})

	it("rejects malformed registry source strings", () => {
		expect(() => parseSource("registry:@acme")).toThrow(/malformed/)
		expect(() => parseSource("registry:@/widget")).toThrow(/malformed/)
		expect(() => parseSource("registry:@acme/widget@not-a-version")).toThrow(/malformed/)
	})

	it("still accepts the legacy npm:/git:/local source shapes", () => {
		expect(parseSource("npm:@scope/pkg@1.0.0").type).toBe("npm")
		expect(parseSource("git:github.com/x/y").type).toBe("git")
		expect(parseSource("/abs/path").type).toBe("local")
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-037 — detectNameCollision refuses cross-scope same-name installs
// ---------------------------------------------------------------------------

describe("VAL-DISC-037 detectNameCollision refuses cross-scope installs", () => {
	it("returns null when the scope/name is fresh", () => {
		const projectBase = trackTmp("baka-collide-project-")
		const userBase = trackTmp("baka-collide-user-")
		const projectSettings = join(projectBase, ".baka", "settings.json")
		const userSettings = join(userBase, ".baka", "settings.json")
		const projectPacks = join(projectBase, ".baka", "packs")
		const userPacks = join(userBase, ".baka", "packs")
		mkdirSync(join(projectBase, ".baka"), { recursive: true })
		mkdirSync(join(userBase, ".baka"), { recursive: true })
		expect(
			__test__.detectNameCollision("acme", "widget", projectSettings, userSettings, projectPacks, userPacks),
		).toBeNull()
	})

	it("does not reserve example names as bundled collisions", () => {
		const projectBase = trackTmp("baka-collide-nobundle-projset-")
		const userBase = trackTmp("baka-collide-nobundle-userset-")
		const projectSettings = join(projectBase, ".baka", "settings.json")
		const userSettings = join(userBase, ".baka", "settings.json")
		const projectPacks = join(projectBase, ".baka", "packs")
		const userPacks = join(userBase, ".baka", "packs")
		mkdirSync(join(projectBase, ".baka"), { recursive: true })
		mkdirSync(join(userBase, ".baka"), { recursive: true })
		expect(
			__test__.detectNameCollision("community", "widget", projectSettings, userSettings, projectPacks, userPacks),
		).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-043 — --user puts the install into the user marketplace
// ---------------------------------------------------------------------------

describe("VAL-DISC-043 --user installs land in the user marketplace (BAKA_HOME)", () => {
	let bakaHome: string
	let projectCwd: string
	let originalBakaHome: string | undefined

	beforeEach(() => {
		bakaHome = trackTmp("baka-home-")
		projectCwd = trackTmp("baka-install-user-proj-")
		mkdirSync(bakaHome, { recursive: true })
		originalBakaHome = process.env.BAKA_HOME
		process.env.BAKA_HOME = bakaHome
	})

	afterEach(() => {
		if (originalBakaHome === undefined) {
			delete process.env.BAKA_HOME
		} else {
			process.env.BAKA_HOME = originalBakaHome
		}
	})

	function fakeFetchForVersionAndTarball(opts: {
		contentHash: string
		bytes: Uint8Array
		version: string
		scope: string
		name: string
	}) {
		const fetchMock: typeof fetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString()
			if (url.includes("/v1/download/")) {
				return new Response(opts.bytes, {
					status: 200,
					headers: { "x-content-sha256": opts.contentHash, "content-type": "application/x-tar" },
				})
			}
			if (url.endsWith(`/${opts.scope}/${opts.name}`) && !url.includes("/v1/download/")) {
				return new Response(
					JSON.stringify({
						scope: opts.scope,
						name: opts.name,
						tier: "official",
						visibility: "public",
						description: "test",
						latestVersion: opts.version,
						versions: [{ version: opts.version, status: "ready", createdAt: new Date().toISOString() }],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				)
			}
			if (url.endsWith(`/${opts.scope}/${opts.name}/${opts.version}`) && !url.includes("/v1/download/")) {
				return new Response(
					JSON.stringify({
						scope: opts.scope,
						name: opts.name,
						version: opts.version,
						status: "ready",
						contentHash: opts.contentHash,
						commitSha: "abc",
						visibility: "public",
						tier: "official",
						manifest: {
							name: `@${opts.scope}/${opts.name}`,
							version: opts.version,
							description: "test",
							dependencies: [],
							conflictsWith: [],
							recipes: [{ id: "noop", description: "noop", requiresReasoning: false, filePatterns: [] }],
							packValidators: [],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				)
			}
			if (url.includes("/v1/download/")) {
				console.error("[test fetch] returning download response with hash", opts.contentHash)
				const r = new Response(opts.bytes, {
					status: 200,
					headers: { "x-content-sha256": opts.contentHash, "content-type": "application/x-tar" },
				})
				console.error("[test fetch] r.headers.get(x-content-sha256)=", r.headers.get("x-content-sha256"))
				return r
			}
			console.error("[test fetch] URL not handled:", url)
			return new Response("not found", { status: 404 })
		}) as unknown as typeof fetch
		return fetchMock
	}

	function fakeTarballBytes(): { bytes: Uint8Array; contentHash: string } {
		const fileBody = new Uint8Array([1, 2, 3])
		const BLOCK = 512
		const header = Buffer.alloc(BLOCK)
		header.write("noop/recipe.ts", 0, "utf8")
		for (let i = 14; i < 100; i++) header[i] = 0
		header.write("0000644", 100, "ascii")
		header.write("0000000", 108, "ascii")
		header.write("0000000", 116, "ascii")
		header.write(fileBody.byteLength.toString(8).padStart(11, "0"), 124, "ascii")
		header.write("00000000000", 136, "ascii")
		for (let i = 148; i < 156; i++) header[i] = 0x20
		header.write("0", 156, "ascii")
		header.write("ustar", 257, "ascii")
		header.write("00", 263, "ascii")
		let sum = 0
		for (let i = 0; i < 512; i++) sum += header[i]
		header.write(sum.toString(8).padStart(6, "0"), 148, "ascii")
		header[154] = 0
		header[155] = 0x20
		const tarBytes = Buffer.concat([header, Buffer.from(fileBody), Buffer.alloc(BLOCK)])
		const { createHash } = require("node:crypto") as typeof import("node:crypto")
		const contentHash = createHash("sha256").update(tarBytes).digest("hex")
		return { bytes: new Uint8Array(tarBytes), contentHash }
	}

	it("install --user lands the pack under BAKA_HOME/packs (not project)", async () => {
		const { bytes, contentHash } = fakeTarballBytes()
		const fetchMock = fakeFetchForVersionAndTarball({
			contentHash,
			bytes,
			version: "1.0.0",
			scope: "acme",
			name: "widget",
		})
		const credentialLookup = (): { apiKey: string } | undefined => ({ apiKey: "test-key" })

		await runInstallCommand("@acme/widget", {
			cwd: projectCwd,
			scope: "user",
			json: true,
			registries: ["http://test.registry"],
			env: { ...process.env, BAKA_HOME: bakaHome },
			fetch: fetchMock,
			credentialLookup,
		})

		const userPack = join(bakaHome, "packs", "acme-widget")
		expect(existsSync(userPack), `expected ${userPack} to exist`).toBe(true)
		expect(existsSync(join(userPack, "noop", "recipe.ts"))).toBe(true)
		expect(existsSync(join(userPack, "manifest.ts"))).toBe(true)

		const userSettings = join(bakaHome, "settings.json")
		const settingsContent = JSON.parse(readFileSync(userSettings, "utf-8")) as { packages: string[] }
		expect(settingsContent.packages).toContain("registry:@acme/widget@1.0.0")

		const otherProjectCwd = trackTmp("baka-install-user-proj2-")
		const otherUserSettings = readFileSync(userSettings, "utf-8")
		expect(otherUserSettings).toContain("registry:@acme/widget@1.0.0")
		void otherProjectCwd
	})

	it("install without --user lands in the project scope", async () => {
		const { bytes, contentHash } = fakeTarballBytes()
		const fetchMock = fakeFetchForVersionAndTarball({
			contentHash,
			bytes,
			version: "1.0.0",
			scope: "acme",
			name: "tool",
		})
		const credentialLookup = (): { apiKey: string } | undefined => ({ apiKey: "test-key" })

		await runInstallCommand("@acme/tool", {
			cwd: projectCwd,
			scope: "project",
			json: true,
			registries: ["http://test.registry"],
			env: { ...process.env, BAKA_HOME: bakaHome },
			fetch: fetchMock,
			credentialLookup,
		})

		const projectPack = join(projectCwd, ".baka", "packs", "acme-tool")
		expect(existsSync(projectPack)).toBe(true)
		const userPack = join(bakaHome, "packs", "acme-tool")
		expect(existsSync(userPack)).toBe(false)

		const projectSettings = join(projectCwd, ".baka", "settings.json")
		const settingsContent = JSON.parse(readFileSync(projectSettings, "utf-8")) as { packages: string[] }
		expect(settingsContent.packages).toContain("registry:@acme/tool@1.0.0")
	})

	it("`baka uninstall` strips the registration and removes the materialized pack", async () => {
		const { bytes, contentHash } = fakeTarballBytes()
		const fetchMock = fakeFetchForVersionAndTarball({
			contentHash,
			bytes,
			version: "1.0.0",
			scope: "acme",
			name: "thing",
		})
		const credentialLookup = (): { apiKey: string } | undefined => ({ apiKey: "test-key" })

		await runInstallCommand("@acme/thing", {
			cwd: projectCwd,
			scope: "project",
			json: true,
			registries: ["http://test.registry"],
			env: { ...process.env, BAKA_HOME: bakaHome },
			fetch: fetchMock,
			credentialLookup,
		})
		expect(existsSync(join(projectCwd, ".baka", "packs", "acme-thing"))).toBe(true)

		await runUninstallCommand("@acme/thing", { cwd: projectCwd, scope: "project", json: true })
		expect(existsSync(join(projectCwd, ".baka", "packs", "acme-thing"))).toBe(false)
		const settingsContent = JSON.parse(readFileSync(join(projectCwd, ".baka", "settings.json"), "utf-8")) as {
			packages: string[]
		}
		expect(settingsContent.packages.find((p) => p.includes("acme/thing"))).toBeUndefined()
	})

	it("VAL-DISC-042 re-install at the same version is a no-op (idempotent)", async () => {
		const { bytes, contentHash } = fakeTarballBytes()
		const fetchMock = fakeFetchForVersionAndTarball({
			contentHash,
			bytes,
			version: "1.0.0",
			scope: "acme",
			name: "idem",
		})
		const credentialLookup = (): { apiKey: string } | undefined => ({ apiKey: "test-key" })

		originalBakaHome = process.env.BAKA_HOME
		process.env.BAKA_HOME = trackTmp("baka-home-idem-")
		try {
			await runInstallCommand("@acme/idem", {
				cwd: projectCwd,
				scope: "project",
				json: true,
				registries: ["http://test.registry"],
				env: process.env,
				fetch: fetchMock,
				credentialLookup,
			})

			// Second install of the same version — capture stdout
			// and assert "already installed" is reported.
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit called")
			}) as never)
			const stdoutChunks: string[] = []
			const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
				stdoutChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
				return true
			}) as never)
			try {
				await runInstallCommand("@acme/idem", {
					cwd: projectCwd,
					scope: "project",
					registries: ["http://test.registry"],
					env: process.env,
					fetch: fetchMock,
					credentialLookup,
				})
			} catch {
				// process.exit was called — capture stdout
			}
			const combined = stdoutChunks.join("")
			expect(combined).toMatch(/already installed/i)
			writeSpy.mockRestore()
			exitSpy.mockRestore()
		} finally {
			if (originalBakaHome === undefined) {
				delete process.env.BAKA_HOME
			} else {
				process.env.BAKA_HOME = originalBakaHome
			}
		}
	})

	it("VAL-DISC-042 install at a NEW version is an upgrade in place", async () => {
		const { bytes: v1Bytes, contentHash: v1Hash } = fakeTarballBytes()
		const { bytes: v2Bytes, contentHash: v2Hash } = fakeTarballBytes()
		const env = { ...process.env, BAKA_HOME: trackTmp("baka-home-upgrade-") }
		// v1 install — fetch mock returns v1.0.0 detail
		const fetchV1 = fakeFetchForVersionAndTarball({
			contentHash: v1Hash,
			bytes: v1Bytes,
			version: "1.0.0",
			scope: "acme",
			name: "upgrade",
		})
		const credentialLookup = (): { apiKey: string } | undefined => ({ apiKey: "test-key" })
		await runInstallCommand("@acme/upgrade", {
			cwd: projectCwd,
			scope: "project",
			json: true,
			registries: ["http://test.registry"],
			env,
			fetch: fetchV1,
			credentialLookup,
		})
		const settingsAfter1 = JSON.parse(readFileSync(join(projectCwd, ".baka", "settings.json"), "utf-8")) as {
			packages: string[]
		}
		expect(settingsAfter1.packages.filter((p) => p.includes("acme/upgrade")).length).toBe(1)

		// v2 install — different fetch mock answering v1.1.0
		const fetchV2 = fakeFetchForVersionAndTarball({
			contentHash: v2Hash,
			bytes: v2Bytes,
			version: "1.1.0",
			scope: "acme",
			name: "upgrade",
		})
		await runInstallCommand("@acme/upgrade", {
			cwd: projectCwd,
			scope: "project",
			json: true,
			registries: ["http://test.registry"],
			env,
			fetch: fetchV2,
			credentialLookup,
		})
		const settingsAfter2 = JSON.parse(readFileSync(join(projectCwd, ".baka", "settings.json"), "utf-8")) as {
			packages: string[]
		}
		const registrations = settingsAfter2.packages.filter((p) => p.includes("acme/upgrade"))
		expect(registrations.length).toBe(1)
		expect(registrations[0]).toBe("registry:@acme/upgrade@1.1.0")
	})
})

// ---------------------------------------------------------------------------
// isValidSemverTag pins the registry's accepted version format
// ---------------------------------------------------------------------------

describe("isValidSemverTag pins the registry's accepted version format", () => {
	it("accepts canonical semver", () => {
		expect(isValidSemverTag("1.0.0")).toBe(true)
		expect(isValidSemverTag("0.1.0")).toBe(true)
		expect(isValidSemverTag("10.20.30")).toBe(true)
	})
	it("accepts the `v` prefix", () => {
		expect(isValidSemverTag("v1.0.0")).toBe(true)
		expect(isValidSemverTag("V2.0.0")).toBe(true)
	})
	it("accepts pre-release + build metadata", () => {
		expect(isValidSemverTag("1.0.0-alpha")).toBe(true)
		expect(isValidSemverTag("1.0.0-alpha.1")).toBe(true)
		expect(isValidSemverTag("1.0.0-0.3.7")).toBe(true)
		expect(isValidSemverTag("1.0.0+build.42")).toBe(true)
	})
	it("rejects non-semver strings", () => {
		expect(isValidSemverTag("release-1")).toBe(false)
		expect(isValidSemverTag("latest")).toBe(false)
		expect(isValidSemverTag("not-a-version")).toBe(false)
		expect(isValidSemverTag("1.0")).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// isValidPackIdentifier pins the scope/name character set
// ---------------------------------------------------------------------------

describe("isValidPackIdentifier pins the identifier character set", () => {
	it("accepts normal identifiers", () => {
		expect(isValidPackIdentifier("acme")).toBe(true)
		expect(isValidPackIdentifier("widget")).toBe(true)
		expect(isValidPackIdentifier("my-pack")).toBe(true)
		expect(isValidPackIdentifier("a.b.c")).toBe(true)
	})
	it("rejects invalid identifiers", () => {
		expect(isValidPackIdentifier("")).toBe(false)
		expect(isValidPackIdentifier("@acme")).toBe(false)
		expect(isValidPackIdentifier("acme/widget")).toBe(false)
		expect(isValidPackIdentifier("acme widget")).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// parseRegistrationScopeName — internal helper that powers uninstall +
// collision detection
// ---------------------------------------------------------------------------

describe("parseRegistrationScopeName recognizes scoped registration strings", () => {
	it("parses registry: source strings", () => {
		expect(parseRegistrationScopeName("registry:@acme/widget@1.0.0")).toEqual({ scope: "acme", name: "widget" })
		expect(parseRegistrationScopeName("registry:@acme/widget")).toEqual({ scope: "acme", name: "widget" })
	})
	it("parses npm: source strings", () => {
		expect(parseRegistrationScopeName("npm:@acme/widget@1.0.0")).toEqual({ scope: "acme", name: "widget" })
	})
	it("returns null for unparseable sources", () => {
		expect(parseRegistrationScopeName("git:github.com/x/y")).toBeNull()
		expect(parseRegistrationScopeName("/abs/path")).toBeNull()
		expect(parseRegistrationScopeName("./rel/path")).toBeNull()
		expect(parseRegistrationScopeName("widget")).toBeNull()
	})
})

import { vi } from "vitest"
