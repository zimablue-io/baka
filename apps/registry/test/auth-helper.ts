import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import type { Hono } from "hono"
import { type BetterAuthHandle, createBetterAuth } from "../src/auth/better-auth"
import { createPgPool } from "../src/auth/kysely-db"
import { applyAppMigrations } from "../src/db/migrate"
import * as schemaModule from "../src/db/schema"
import { buildApp } from "../src/index"

/**
 * Test helper for the auth feature (architecture §4.4).
 *
 * Boots a fresh PGlite in a tmp dir, applies the app migrations, starts
 * the pglite-socket on an ephemeral port, builds a Better-Auth instance
 * bound to that socket via `pg.Pool`, runs Better-Auth's introspection-
 * driven migrations, and returns a fully wired Hono app + cleanup.
 *
 * The fixture uses the same `createDatabase`/`buildApp`/`startServer`
 * paths the production binary uses; the only short-circuit is binding
 * to ephemeral ports (so the test never races the manifest's 4300 /
 * 5444). This is the documented test pattern (registry-worker skill,
 * step 2: integration tests boot the real server stack).
 */

export interface AuthTestStack {
	app: Hono
	betterAuth: BetterAuthHandle
	pglite: PGlite
	socket: PGLiteSocketServer
	baseUrl: string
	pgliteDir: string
	dataDir: string
	/** Closes the socket, pool, and PGlite; removes the tmp dir. */
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

interface BuildAuthStackOptions {
	/** Override base URL (defaults to `http://127.0.0.1:<port>`). */
	baseUrl?: string
	/** Override GitHub OAuth client id for the test. */
	githubClientId?: string
	/** Override GitHub OAuth client secret for the test. */
	githubClientSecret?: string
	/** Override session/cookie secret for the test. */
	secret?: string
}

export async function buildAuthTestStack(options: BuildAuthStackOptions = {}): Promise<AuthTestStack> {
	const dataDir = mkdtempSync(join(tmpdir(), "baka-registry-auth-"))
	const pgliteDir = join(dataDir, "pg")
	const socketPort = await pickEphemeralPort()

	// Open PGlite, apply app migrations (idempotent), and start the
	// pglite-socket so Better-Auth's Kysely adapter can connect.
	const pglite = await PGlite.create(pgliteDir)
	await applyAppMigrations(pglite)
	const socket = new PGLiteSocketServer({
		db: pglite,
		port: socketPort,
		host: "127.0.0.1",
		maxConnections: 10,
	})
	await socket.start()

	// Build Better-Auth against the live socket.
	const pool = createPgPool({ port: socketPort, host: "127.0.0.1" })
	const baseUrl = options.baseUrl ?? `http://127.0.0.1:${socketPort + 1}`
	const betterAuth = await createBetterAuth(pool, {
		baseUrl,
		githubClientId: options.githubClientId ?? "test-github-client-id",
		githubClientSecret: options.githubClientSecret ?? "test-github-client-secret",
		secret: options.secret ?? "test-secret-do-not-use-in-production",
	})
	await betterAuth.ensureTables()

	const app = buildApp({ auth: betterAuth.auth, pglite })

	return {
		app,
		betterAuth,
		pglite,
		socket,
		baseUrl,
		pgliteDir,
		dataDir,
		close: async () => {
			await betterAuth.close().catch(() => {})
			await socket.stop().catch(() => {})
			await pglite.close().catch(() => {})
			rmSync(dataDir, { recursive: true, force: true })
		},
	}
}

/**
 * Convenience: seed a module row directly via Drizzle. Used by tests
 * for the visibility-aware read assertion (VAL-AUTH-003).
 */
export async function seedModule(
	stack: AuthTestStack,
	input: {
		scope: string
		name: string
		visibility: "public" | "org"
		tier?: string
		description?: string
	},
): Promise<void> {
	const { drizzle } = await import("drizzle-orm/pglite")
	const db = drizzle(stack.pglite, { schema: schemaModule })
	await db.insert(schemaModule.modules).values({
		scope: input.scope,
		name: input.name,
		visibility: input.visibility,
		tier: input.tier ?? "community-unverified",
		description: input.description ?? "",
	})
}
