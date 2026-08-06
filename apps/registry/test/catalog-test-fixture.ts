import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import type { Hono } from "hono"
import { type BetterAuthHandle, createBetterAuth } from "../src/auth/better-auth"
import { createPgPool } from "../src/auth/kysely-db"
import { ensureOrgPlanColumn } from "../src/auth/plan-limits"
import { seedBuiltInCatalog } from "../src/catalog/seed"
import { applyAppMigrations } from "../src/db/migrate"
import { buildApp } from "../src/index"
import { createFilesystemStorage, type StorageAdapter } from "../src/storage"

/**
 * Test fixture for the catalog read-paths feature.
 *
 * Boots a fresh PGlite + Better-Auth + Hono stack, applies the app
 * migrations, then seeds the built-in catalog (baka-base, sdd, ts-style
 * under the official `baka` scope). The same seeder runs at every real
 * boot via `server.ts`; the fixture mirrors that flow so the test path
 * is identical to production wiring.
 */

export interface CatalogTestStack {
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

export async function buildCatalogTestStack(): Promise<CatalogTestStack> {
	const dataDir = mkdtempSync(join(tmpdir(), "baka-registry-catalog-"))
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
	})
	await betterAuth.ensureTables()
	await ensureOrgPlanColumn(pglite)

	await seedBuiltInCatalog(pglite, "baka")

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
