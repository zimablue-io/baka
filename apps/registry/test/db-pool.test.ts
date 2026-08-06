import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "pg"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createDatabase } from "../src/db/client"

/**
 * Architecture §4.2 verified fact: pglite-socket requires maxConnections=10
 * (default 1 causes ECONNRESET under pooling). This test boots the socket
 * server on an ephemeral port and exercises multiple concurrent clients
 * through node-pg to prove the pool discipline holds.
 *
 * The pool supports Better-Auth's Kysely adapter (which the runtime
 * authentication path uses), the publish-route clone helpers, and any
 * future out-of-process worker pointing at the socket. They all reuse
 * the same verified 10-slot discipline.
 *
 * `pg` is a devDep used purely for this harness.
 */

let dataDir: string
let pgliteDir: string

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "baka-registry-db-pool-"))
	pgliteDir = join(dataDir, "pg")
})

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true })
})

async function pickEphemeralPort(): Promise<number> {
	const net = await import("node:net")
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

describe("pglite-socket connection pool", () => {
	it("reports maxConnections: 10 in the live server stats", async () => {
		const port = await pickEphemeralPort()
		const handle = await createDatabase({ dataDir: pgliteDir, socketPort: port, startSocket: true })
		try {
			const socket = handle.socket
			expect(socket).not.toBeNull()
			if (!socket) throw new Error("expected socket to be started")
			const stats = socket.getStats()
			expect(stats.maxConnections).toBe(10)
		} finally {
			await handle.close()
		}
	})

	it("accepts multiple concurrent node-pg clients (proves the 10-slot pool)", async () => {
		const port = await pickEphemeralPort()
		const handle = await createDatabase({ dataDir: pgliteDir, socketPort: port, startSocket: true })
		try {
			const socket = handle.socket
			if (!socket) throw new Error("expected socket to be started")
			const clientCount = 8
			const clients = await Promise.all(
				Array.from({ length: clientCount }, async () => {
					const c = new Client({
						host: "127.0.0.1",
						port,
						user: "postgres",
						password: "postgres",
						database: "postgres",
						connectionTimeoutMillis: 5_000,
					})
					await c.connect()
					return c
				}),
			)

			try {
				const results = await Promise.all(clients.map((c) => c.query("SELECT 1 AS one")))
				for (const r of results) {
					expect(r.rows[0]?.one).toBe(1)
				}
				const stats = socket.getStats()
				expect(stats.activeConnections).toBe(clientCount)
				expect(stats.maxConnections).toBe(10)
			} finally {
				await Promise.all(clients.map((c) => c.end().catch(() => {})))
			}
		} finally {
			await handle.close()
		}
	})

	it("exposes the same PGlite data through the socket as in-process Drizzle sees", async () => {
		const port = await pickEphemeralPort()
		const handle = await createDatabase({ dataDir: pgliteDir, socketPort: port, startSocket: true })
		try {
			await handle.db.insert(handle.schema.modules).values({
				scope: "acme",
				name: "via-socket",
				visibility: "org",
				tier: "community-unverified",
				description: "round-trip",
			})

			const client = new Client({
				host: "127.0.0.1",
				port,
				user: "postgres",
				password: "postgres",
				database: "postgres",
			})
			await client.connect()
			try {
				const result = await client.query(`SELECT name, visibility, tier FROM modules WHERE scope = $1`, ["acme"])
				expect(result.rows).toEqual([{ name: "via-socket", visibility: "org", tier: "community-unverified" }])
			} finally {
				await client.end().catch(() => {})
			}
		} finally {
			await handle.close()
		}
	})

	it("a stopped socket frees the port (no leaked listeners across boots)", async () => {
		const port = await pickEphemeralPort()
		const handle = await createDatabase({ dataDir: pgliteDir, socketPort: port, startSocket: true })
		const socket = handle.socket
		if (!socket) throw new Error("expected socket to be started")
		const url = socket.getServerConn()
		expect(url).toMatch(new RegExp(`127\\.0\\.0\\.1:${port}`))
		await handle.close()

		// Reboot on the same port.
		const second = await createDatabase({ dataDir: pgliteDir, socketPort: port, startSocket: true })
		try {
			const secondSocket = second.socket
			if (!secondSocket) throw new Error("expected second socket to be started")
			expect(secondSocket.getServerConn()).toMatch(new RegExp(`127\\.0\\.0\\.1:${port}`))
		} finally {
			await second.close()
		}
	})

	it("the default createDatabase() (no socket) still boots successfully (no socket start side-effects)", async () => {
		const handle = await createDatabase({ dataDir: pgliteDir })
		try {
			expect(handle.socket).toBeNull()
			// In-process Drizzle is fully usable.
			const inserted = await handle.db
				.insert(handle.schema.modules)
				.values({
					scope: "acme",
					name: "in-proc",
					visibility: "org",
					tier: "community-unverified",
					description: "x",
				})
				.returning({ id: handle.schema.modules.id })
			expect(inserted[0]?.id).toBeTruthy()
		} finally {
			await handle.close()
		}
	})
})
