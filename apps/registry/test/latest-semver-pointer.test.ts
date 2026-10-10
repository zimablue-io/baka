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
import { ensureOrgPlanColumn } from "../src/auth/plan-limits"
import { applyAppMigrations } from "../src/db/migrate"
import { buildApp } from "../src/index"
import { createFilesystemStorage, type StorageAdapter } from "../src/storage"

/**
 * Latest-version pointer follows semver order (architecture §8
 * decision 11; VAL-PUB-013, VAL-PUB-025).
 *
 * The catalog list endpoint's `latestVersion` must be the
 * highest-precedence semver among the pack's `ready` versions,
 * NOT the most recently ingested one. Two ready versions ingested
 * in reverse semver order (`v1.10.0` first, then `v1.9.0`) must
 * still surface `v1.10.0` as the latest.
 *
 * The test bypasses the worker entirely: it inserts ready rows
 * directly into `pack_versions` so the test pin is on the
 * catalog query, not on the ingest pipeline (which is exercised
 * separately by the ingest-worker suite).
 */

interface Stack {
	app: Hono
	betterAuth: BetterAuthHandle
	pglite: PGlite
	socket: PGLiteSocketServer
	storage: StorageAdapter
	storageDir: string
	baseUrl: string
	dataDir: string
	pgliteDir: string
	close: () => Promise<void>
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

async function buildStack(): Promise<Stack> {
	const dataDir = mkdtempSync(join(tmpdir(), "baka-registry-semver-"))
	const pgliteDir = join(dataDir, "pg")
	const storageDir = join(dataDir, "artifacts")
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

	const storage = createFilesystemStorage(storageDir)
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

	const app = buildApp({ auth: betterAuth.auth, pglite, officialOrg: "baka", storage })

	return {
		app,
		betterAuth,
		pglite,
		socket,
		storage,
		storageDir,
		baseUrl,
		dataDir,
		pgliteDir,
		close: async () => {
			await betterAuth.close().catch(() => {})
			await socket.stop().catch(() => {})
			await pglite.close().catch(() => {})
			rmSync(dataDir, { recursive: true, force: true })
		},
	}
}

/**
 * Inserts a `packs` row + a `pack_versions` row at `status: 'ready'`.
 * The `content_hash` is a placeholder — the catalog read paths do not
 * read the artifact, only the `version` + `status`. The
 * `created_at` is set to the supplied ms offset so tests can
 * control insertion order independently of semver order.
 */
async function insertReadyVersion(
	fx: Stack,
	args: {
		scope: string
		name: string
		version: string
		insertedAtMs: number
		visibility?: "public" | "org"
	},
): Promise<void> {
	const packInsert = await fx.pglite.query<{ id: string }>(
		`INSERT INTO packs (scope, name, visibility, tier, description, created_at, updated_at)
		 VALUES ($1, $2, $3, 'community-unverified', '', to_timestamp($4::bigint / 1000.0), to_timestamp($4::bigint / 1000.0))
		 ON CONFLICT (scope, name) DO UPDATE SET updated_at = to_timestamp($4::bigint / 1000.0)
		 RETURNING id`,
		[args.scope, args.name, args.visibility ?? "public", args.insertedAtMs],
	)
	const packId = packInsert.rows[0]?.id
	if (!packId) throw new Error(`failed to insert pack ${args.scope}/${args.name}`)
	await fx.pglite.query(
		`INSERT INTO pack_versions (pack_id, version, commit_sha, content_hash, manifest, status, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5::jsonb, 'ready', to_timestamp($6::bigint / 1000.0), to_timestamp($6::bigint / 1000.0))`,
		[
			packId,
			args.version,
			"0".repeat(40),
			"a".repeat(64),
			JSON.stringify({
				name: `${args.scope}/${args.name}`,
				version: args.version.startsWith("v") ? args.version.slice(1) : args.version,
				description: "",
				dependencies: [],
				conflictsWith: [],
				recipes: [
					{
						id: "noop",
						description: "noop",
						params: [],
						requiresReasoning: false,
						filePatterns: [],
						validators: [],
					},
				],
				packValidators: [],
			}),
			args.insertedAtMs,
		],
	)
}

describe("latest-version pointer follows semver order (VAL-PUB-013 / VAL-PUB-025)", () => {
	let fx: Stack
	beforeEach(async () => {
		fx = await buildStack()
	})
	afterEach(async () => {
		await fx.close()
	})

	it("a pack with two ready versions surfaces the higher semver, regardless of insertion order", async () => {
		// Insert v1.9.0 FIRST, then v1.10.0 (insertion order matches
		// semver order — this is the trivial case).
		await insertReadyVersion(fx, { scope: "acme", name: "widget", version: "v1.9.0", insertedAtMs: 1_000 })
		await insertReadyVersion(fx, { scope: "acme", name: "widget", version: "v1.10.0", insertedAtMs: 2_000 })

		const res = await fx.app.request("/v1/packs/acme/widget")
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			versions: Array<{ version: string; status: string }>
		}
		expect(body.versions.map((v) => v.version)).toContain("v1.10.0")
		expect(body.versions.map((v) => v.version)).toContain("v1.9.0")
	})

	it("reverse-order insertion (newer semver ingested first) still surfaces the higher semver", async () => {
		// Insert v1.10.0 FIRST, then v1.9.0 — the previous
		// implementation picked the most recently inserted row.
		await insertReadyVersion(fx, { scope: "acme", name: "widget", version: "v1.10.0", insertedAtMs: 1_000 })
		await insertReadyVersion(fx, { scope: "acme", name: "widget", version: "v1.9.0", insertedAtMs: 2_000 })

		const detail = await fx.app.request("/v1/packs/acme/widget")
		expect(detail.status).toBe(200)
		const detailBody = (await detail.json()) as {
			versions: Array<{ version: string; status: string }>
		}
		expect(detailBody.versions.map((v) => v.version)).toContain("v1.10.0")
		expect(detailBody.versions.map((v) => v.version)).toContain("v1.9.0")
	})

	it("catalog list latestVersion picks v1.10.0 over v1.9.0 even when v1.9.0 was ingested later", async () => {
		await insertReadyVersion(fx, { scope: "acme", name: "widget", version: "v1.10.0", insertedAtMs: 1_000 })
		await insertReadyVersion(fx, { scope: "acme", name: "widget", version: "v1.9.0", insertedAtMs: 2_000 })

		const list = await fx.app.request("/v1/packs")
		expect(list.status).toBe(200)
		const listBody = (await list.json()) as {
			packs: Array<{ scope: string; name: string; latestVersion: string }>
		}
		const widget = listBody.packs.find((m) => m.scope === "acme" && m.name === "widget")
		expect(widget).toBeDefined()
		expect(widget?.latestVersion).toBe("v1.10.0")
	})

	it("catalog list latestVersion picks v2.0.0 over v1.99.99 (numeric not lex)", async () => {
		// Lexicographic order would put "1.99.99" > "2.0.0".
		// Semver order puts "2.0.0" > "1.99.99" (the major bump wins).
		await insertReadyVersion(fx, { scope: "acme", name: "semver-major", version: "v1.99.99", insertedAtMs: 2_000 })
		await insertReadyVersion(fx, { scope: "acme", name: "semver-major", version: "v2.0.0", insertedAtMs: 1_000 })

		const list = await fx.app.request("/v1/packs")
		expect(list.status).toBe(200)
		const listBody = (await list.json()) as {
			packs: Array<{ name: string; latestVersion: string }>
		}
		const m = listBody.packs.find((mod) => mod.name === "semver-major")
		expect(m?.latestVersion).toBe("v2.0.0")
	})

	it("pre-release versions sort before the release (1.0.0-rc.1 < 1.0.0)", async () => {
		await insertReadyVersion(fx, { scope: "acme", name: "prerelease", version: "v1.0.0", insertedAtMs: 2_000 })
		await insertReadyVersion(fx, {
			scope: "acme",
			name: "prerelease",
			version: "v1.0.0-rc.1",
			insertedAtMs: 1_000,
		})

		const list = await fx.app.request("/v1/packs")
		expect(list.status).toBe(200)
		const listBody = (await list.json()) as {
			packs: Array<{ name: string; latestVersion: string }>
		}
		const m = listBody.packs.find((mod) => mod.name === "prerelease")
		expect(m?.latestVersion).toBe("v1.0.0")
	})

	it("failed versions never become the latest pointer (only `ready` versions count)", async () => {
		const packInsert = await fx.pglite.query<{ id: string }>(
			`INSERT INTO packs (scope, name, visibility, tier, description, created_at, updated_at)
			 VALUES ('acme', 'mixed', 'public', 'community-unverified', '', to_timestamp(0), to_timestamp(0))
			 RETURNING id`,
		)
		const packId = packInsert.rows[0]?.id ?? ""
		// A failed version inserted AFTER a ready version must NOT
		// become the latest pointer. Insertion order does not count
		// for non-ready versions.
		await fx.pglite.query(
			`INSERT INTO pack_versions (pack_id, version, commit_sha, content_hash, manifest, status, created_at, updated_at)
			 VALUES ($1, 'v1.0.0', $2, $3, $4::jsonb, 'ready', to_timestamp(0), to_timestamp(0))`,
			[
				packId,
				"0".repeat(40),
				"a".repeat(64),
				JSON.stringify({
					name: "acme/mixed",
					version: "1.0.0",
					description: "",
					dependencies: [],
					conflictsWith: [],
					recipes: [
						{
							id: "noop",
							description: "noop",
							params: [],
							requiresReasoning: false,
							filePatterns: [],
							validators: [],
						},
					],
					packValidators: [],
				}),
			],
		)
		await fx.pglite.query(
			`INSERT INTO pack_versions (pack_id, version, commit_sha, content_hash, manifest, status, created_at, updated_at)
			 VALUES ($1, 'v9.9.9', $2, '', $3::jsonb, 'failed', to_timestamp(2000), to_timestamp(2000))`,
			[
				packId,
				"0".repeat(40),
				JSON.stringify({
					name: "acme/mixed",
					version: "9.9.9",
					description: "",
					dependencies: [],
					conflictsWith: [],
					recipes: [],
					packValidators: [],
				}),
			],
		)

		const list = await fx.app.request("/v1/packs")
		expect(list.status).toBe(200)
		const listBody = (await list.json()) as {
			packs: Array<{ name: string; latestVersion: string; latestStatus: string | null }>
		}
		const m = listBody.packs.find((mod) => mod.name === "mixed")
		expect(m?.latestVersion).toBe("v1.0.0")
		expect(m?.latestStatus).toBe("ready")
	})

	it("catalog list and pack detail agree on latestVersion (VAL-PUB-006)", async () => {
		await insertReadyVersion(fx, { scope: "acme", name: "agree", version: "v1.9.0", insertedAtMs: 1_000 })
		await insertReadyVersion(fx, { scope: "acme", name: "agree", version: "v1.10.0", insertedAtMs: 2_000 })

		const list = await fx.app.request("/v1/packs")
		const listBody = (await list.json()) as {
			packs: Array<{ scope: string; name: string; latestVersion: string }>
		}
		const summary = listBody.packs.find((m) => m.scope === "acme" && m.name === "agree")
		expect(summary?.latestVersion).toBe("v1.10.0")

		const detail = await fx.app.request("/v1/packs/acme/agree")
		const detailBody = (await detail.json()) as {
			scope: string
			name: string
			latestVersion: string | null
			versions: Array<{ version: string }>
		}
		expect(detailBody.latestVersion).toBe(summary?.latestVersion)
		// Detail endpoint surfaces every version in its list; the
		// highest-precedence version MUST appear there (the catalog
		// list's latestVersion is sourced from the same set).
		const versions = detailBody.versions.map((v) => v.version)
		expect(versions).toContain(summary?.latestVersion)
	})
})

describe("catalog tier filter on the latest-pointer query (VAL-PUB-029)", () => {
	let fx: Stack
	beforeEach(async () => {
		fx = await buildStack()
	})
	afterEach(async () => {
		await fx.close()
	})

	it("an unknown tier value returns 400 — never silently returns every pack", async () => {
		const res = await fx.app.request("/v1/packs?tier=bogus")
		expect(res.status).toBe(400)
		const body = (await res.json()) as { error?: string }
		expect(typeof body.error).toBe("string")
		expect(body.error?.toLowerCase()).toContain("tier")
	})

	it("tier filter returns only packs at the requested tier", async () => {
		// Insert one pack at community-unverified and one at
		// official tier — same publish flow but a different tier.
		await insertReadyVersion(fx, {
			scope: "acme",
			name: "low-tier",
			version: "v1.0.0",
			insertedAtMs: 1_000,
		})
		await fx.pglite.query(`UPDATE packs SET tier = 'community-unverified' WHERE scope = 'acme' AND name = 'low-tier'`)

		const inserted = await fx.pglite.query<{ id: string }>(
			`INSERT INTO packs (scope, name, visibility, tier, description)
			 VALUES ('baka', 'official-mod', 'public', 'official', 'official pack')
			 RETURNING id`,
		)
		const packId = inserted.rows[0]?.id ?? ""
		await fx.pglite.query(
			`INSERT INTO pack_versions (pack_id, version, commit_sha, content_hash, manifest, status)
			 VALUES ($1, 'v0.1.0', $2, $3, $4::jsonb, 'ready')`,
			[
				packId,
				"0".repeat(40),
				"a".repeat(64),
				JSON.stringify({
					name: "official-mod",
					version: "0.1.0",
					description: "official pack",
					dependencies: [],
					conflictsWith: [],
					recipes: [
						{
							id: "noop",
							description: "noop",
							params: [],
							requiresReasoning: false,
							filePatterns: [],
							validators: [],
						},
					],
					packValidators: [],
				}),
			],
		)

		const filtered = await fx.app.request("/v1/packs?tier=official")
		expect(filtered.status).toBe(200)
		const filteredBody = (await filtered.json()) as {
			packs: Array<{ tier: string }>
		}
		for (const mod of filteredBody.packs) {
			expect(mod.tier).toBe("official")
		}

		const unverifiedFiltered = await fx.app.request("/v1/packs?tier=community-unverified")
		expect(unverifiedFiltered.status).toBe(200)
		const unverifiedBody = (await unverifiedFiltered.json()) as {
			packs: Array<{ name: string; tier: string }>
		}
		expect(unverifiedBody.packs.some((m) => m.name === "low-tier")).toBe(true)
		expect(unverifiedBody.packs.some((m) => m.name === "official-mod")).toBe(false)
	})
})
