import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite"
import { applyAppMigrations } from "./migrate"
import * as schema from "./schema"

/**
 * Database client (architecture §4.2).
 *
 * One in-process PGlite instance backs two surfaces:
 *   1. A Drizzle ORM client used by Hono route handlers in the same process.
 *   2. A pglite-socket TCP server (port 5444 by default) that exposes the
 *      same PGlite to out-of-process clients (graphile-worker via node-pg).
 *
 * The pglite-socket is the proven interop seam (verified dependency fact
 * `library/environment.md`): maxConnections=10 keeps the query queue from
 * deadlocking under the worker's pool; the default of 1 ECONNRESETs under
 * any concurrency.
 *
 * Migrations are applied as part of every boot so a self-host cold start
 * lands on a ready schema with zero manual steps. The migration runner is
 * idempotent (see `./migrate.ts`) so re-opening an existing data dir is a
 * no-op.
 *
 * Lifecycle: callers MUST `await handle.close()` when finished — PGlite and
 * the socket server both hold OS resources (file handles, listening ports)
 * that block subsequent boots on the same data dir / port otherwise.
 */

export interface DatabaseHandle {
	/** Drizzle ORM client bound to the in-process PGlite. */
	db: PgliteDatabase<typeof schema>
	/** The schema namespace (re-exported for ergonomic query DSL). */
	schema: typeof schema
	/** The underlying PGlite instance (for diagnostics, raw queries, tests). */
	pglite: PGlite
	/** The pglite-socket TCP server, or null if `startSocket: false`. */
	socket: PGLiteSocketServer | null
	/** Releases PGlite + socket resources. Idempotent. */
	close: () => Promise<void>
}

/**
 * The maximum number of concurrent TCP connections the pglite-socket accepts.
 * Architecture §4.2 verified dependency fact: default 1 breaks pooling under
 * graphile-worker; 10 matches the worker's per-process pool size.
 */
const DEFAULT_SOCKET_MAX_CONNECTIONS = 10

interface CreateDatabaseOptions {
	/** Absolute path to the directory holding PGlite's data files. */
	dataDir: string
	/** TCP port for the pglite-socket (ignored unless `startSocket: true`). */
	socketPort?: number
	/** Bind host for the pglite-socket. Defaults to loopback (`127.0.0.1`). */
	socketHost?: string
	/** Start the pglite-socket TCP server. Defaults to false (tests). */
	startSocket?: boolean
	/** Override the socket's maxConnections. Defaults to 10 (verified fact). */
	socketMaxConnections?: number
}

/**
 * Opens the in-process PGlite, applies migrations, constructs the Drizzle
 * client, and (optionally) starts the pglite-socket TCP server.
 *
 * Always apply migrations on boot so a fresh data dir self-bootstraps to
 * the current schema with zero manual steps.
 */
export async function createDatabase(options: CreateDatabaseOptions): Promise<DatabaseHandle> {
	const pglite = await PGlite.create(options.dataDir)
	await applyAppMigrations(pglite)
	const db = drizzle(pglite, { schema })

	let socket: PGLiteSocketServer | null = null
	if (options.startSocket === true) {
		if (options.socketPort === undefined) {
			throw new Error("createDatabase: socketPort is required when startSocket is true")
		}
		socket = new PGLiteSocketServer({
			db: pglite,
			port: options.socketPort,
			host: options.socketHost ?? "127.0.0.1",
			maxConnections: options.socketMaxConnections ?? DEFAULT_SOCKET_MAX_CONNECTIONS,
		})
		await socket.start()
	}

	let closed = false
	return {
		db,
		schema,
		pglite,
		socket,
		close: async () => {
			if (closed) return
			closed = true
			if (socket) {
				await socket.stop()
			}
			await pglite.close()
		},
	}
}
