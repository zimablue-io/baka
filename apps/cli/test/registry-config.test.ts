// ---------------------------------------------------------------------------
// Registry config resolver (architecture §8 decisions 4 + 33 + 27).
//
// Unit tests for the URL-resolution helpers in
// `apps/cli/src/lib/registry-config.ts`. The same resolver is shared
// across every CLI surface that needs to know which registry to talk
// to, so the precedence contract gets pinned here:
//
//   --registry <url>           >  flag — wins outright
//   BAKA_REGISTRY_URL          >  env — wins when no flag is set
//   .baka/settings.json.registries > project — wins when no env is set
//   http://localhost:4300      >  default — only consulted when nothing
//                                  else applies
//
// For a single-registry command, the resolver returns ONE URL. For
// a multi-registry command (search/install), the resolver returns the
// LIST of URLs to query, in the precedence order above. Decision 27
// pins the per-hit attribution field as `registry` (the base URL),
// and decision 4 pins first-listed-wins for scoped-name conflicts.
// ---------------------------------------------------------------------------

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type ProjectRegistries, resolveRegistryList, resolveSingleRegistryUrl } from "../src/lib/registry-config"

const TMP_PREFIX = "baka-regcfg-"
const DEFAULT_URL = "http://localhost:4300"

let tmpDir: string

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), TMP_PREFIX))
	mkdirSync(join(tmpDir, ".baka"), { recursive: true })
})

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true })
})

function seedProjectRegistries(registries: ProjectRegistries | null): void {
	if (registries === null) return
	const settingsPath = join(tmpDir, ".baka", "settings.json")
	writeFileSync(settingsPath, JSON.stringify({ packages: [], registries }, null, 2), "utf-8")
}

function freshEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (key === "BAKA_REGISTRY_URL") continue
		env[key] = value
	}
	return env
}

// ---------------------------------------------------------------------------
// Single-registry resolution
// ---------------------------------------------------------------------------

describe("resolveSingleRegistryUrl", () => {
	it("returns the --registry flag value when present, overriding env and project settings", () => {
		const registries: ProjectRegistries = ["http://project-host:4310"]
		const env = { ...freshEnv(), BAKA_REGISTRY_URL: "http://env-host:4311" }
		expect(resolveSingleRegistryUrl("http://flag-host:4312", { cwd: tmpDir, env, projectRegistries: registries })).toBe(
			"http://flag-host:4312",
		)
	})

	it("returns the BAKA_REGISTRY_URL env when no flag is set", () => {
		const env = { ...freshEnv(), BAKA_REGISTRY_URL: "http://env-host:4311" }
		const registries: ProjectRegistries = ["http://project-host:4310"]
		expect(resolveSingleRegistryUrl(undefined, { cwd: tmpDir, env, projectRegistries: registries })).toBe(
			"http://env-host:4311",
		)
	})

	it("returns the first project-registry entry when no flag and no env are set", () => {
		const env = freshEnv()
		const registries: ProjectRegistries = ["http://project-first:4310", "http://project-second:4311"]
		expect(resolveSingleRegistryUrl(undefined, { cwd: tmpDir, env, projectRegistries: registries })).toBe(
			"http://project-first:4310",
		)
	})

	it("returns the default when nothing else is configured", () => {
		expect(resolveSingleRegistryUrl(undefined, { cwd: tmpDir, env: freshEnv(), projectRegistries: [] })).toBe(
			DEFAULT_URL,
		)
	})

	it("normalizes the flag URL (drops trailing slashes, lowercases scheme+host)", () => {
		expect(
			resolveSingleRegistryUrl("HTTP://Flag-Host:4312/", {
				cwd: tmpDir,
				env: freshEnv(),
				projectRegistries: [],
			}),
		).toBe("http://flag-host:4312")
	})
})

// ---------------------------------------------------------------------------
// Multi-registry resolution
// ---------------------------------------------------------------------------

describe("resolveRegistryList", () => {
	it("returns the --registry flag as the single registry list when present, overriding everything", () => {
		const env = { ...freshEnv(), BAKA_REGISTRY_URL: "http://env-host:4311" }
		const registries: ProjectRegistries = ["http://project-host:4310"]
		expect(resolveRegistryList("http://flag-host:4312", { cwd: tmpDir, env, projectRegistries: registries })).toEqual([
			"http://flag-host:4312",
		])
	})

	it("returns the BAKA_REGISTRY_URL as a one-element list when no flag is set", () => {
		const env = { ...freshEnv(), BAKA_REGISTRY_URL: "http://env-host:4311" }
		const registries: ProjectRegistries = ["http://project-host:4310"]
		expect(resolveRegistryList(undefined, { cwd: tmpDir, env, projectRegistries: registries })).toEqual([
			"http://env-host:4311",
		])
	})

	it("returns the full project registries list (in order) when no flag and no env are set", () => {
		const env = freshEnv()
		const registries: ProjectRegistries = [
			"http://project-first:4310",
			"http://project-second:4311",
			"http://project-third:4312",
		]
		expect(resolveRegistryList(undefined, { cwd: tmpDir, env, projectRegistries: registries })).toEqual(registries)
	})

	it("returns [default] when nothing else is configured", () => {
		expect(resolveRegistryList(undefined, { cwd: tmpDir, env: freshEnv(), projectRegistries: [] })).toEqual([
			DEFAULT_URL,
		])
	})

	it("loads project registries from .baka/settings.json when no override is provided", () => {
		seedProjectRegistries(["http://from-disk:4310", "http://from-disk:4311"])
		expect(resolveRegistryList(undefined, { cwd: tmpDir, env: freshEnv() })).toEqual([
			"http://from-disk:4310",
			"http://from-disk:4311",
		])
	})

	it("normalizes every registry URL through normalizeRegistryUrl semantics", () => {
		const env = freshEnv()
		const registries: ProjectRegistries = ["HTTP://Mixed-Case:4310/", "https://other:4311/api"]
		expect(resolveRegistryList(undefined, { cwd: tmpDir, env, projectRegistries: registries })).toEqual([
			"http://mixed-case:4310",
			"https://other:4311/api",
		])
	})

	it("treats malformed project settings (non-list registries) as empty — same fallback as default", () => {
		seedProjectRegistries("not-a-list" as unknown as ProjectRegistries)
		const env = freshEnv()
		expect(resolveRegistryList(undefined, { cwd: tmpDir, env, projectRegistries: undefined })).toEqual([DEFAULT_URL])
	})

	it("treats syntactically invalid .baka/settings.json as empty — same fallback as default", () => {
		writeFileSync(join(tmpDir, ".baka", "settings.json"), "{ not json", "utf-8")
		const env = freshEnv()
		expect(resolveRegistryList(undefined, { cwd: tmpDir, env, projectRegistries: undefined })).toEqual([DEFAULT_URL])
	})
})
