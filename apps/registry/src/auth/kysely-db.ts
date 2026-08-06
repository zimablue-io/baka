import { Kysely, PostgresDialect } from "kysely"
import pg from "pg"

/**
 * Kysely over the pglite-socket TCP bridge (architecture §4.2, verified
 * dependency fact in `library/environment.md`).
 *
 * Better-Auth's adapter (`@better-auth/kysely-adapter`) requires a
 * `PostgresPool` (a `pg.Pool`) so it can issue parameterized SQL against
 * Postgres via node-pg. The pglite-socket is the proven bridge between
 * node-pg and the in-process PGlite (verified: `maxConnections=10`,
 * poll-based pickup, no shared LISTEN/NOTIFY across the socket).
 *
 * This module is the only place `pg.Pool` is constructed at runtime in
 * the registry server. Every auth-side query that Better-Auth issues goes
 * through here. The app-side queries (Drizzle + the in-process PGlite)
 * continue to flow through `db/client.ts`; the two paths coexist against
 * the same PGlite data dir.
 */

const { Pool } = pg

interface PgPoolOptions {
	/** TCP port the pglite-socket listens on. */
	port: number
	/** Bind host. Defaults to loopback (`127.0.0.1`). */
	host?: string
	/** Optional override for the pool size. Defaults to 10 (verified fact). */
	max?: number
}

/**
 * Constructs a `pg.Pool` wired to the pglite-socket. The pool uses the
 * default credentials PGlite accepts (no auth) and a tight connection
 * timeout so a server that has not yet bound the socket fails fast
 * instead of hanging.
 */
export function createPgPool(options: PgPoolOptions): pg.Pool {
	return new Pool({
		host: options.host ?? "127.0.0.1",
		port: options.port,
		user: "postgres",
		password: "postgres",
		database: "postgres",
		max: options.max ?? 10,
		connectionTimeoutMillis: 5_000,
	})
}

/**
 * Builds a bare Kysely instance over the given `pg.Pool`. The DB type is
 * intentionally untyped (`{ [k: string]: unknown }`): Better-Auth reads
 * the schema dynamically through its introspection, so a precise DB
 * interface would force us to mirror every auth plugin's columns here.
 *
 * The pool is NOT closed by this helper — Better-Auth owns the lifetime
 * via its adapter. Callers pass the same pool to `createBetterAuth` and
 * close it via the returned handle's `close()`.
 */
export function createKysely(pool: pg.Pool): Kysely<Record<string, unknown>> {
	return new Kysely<Record<string, unknown>>({
		dialect: new PostgresDialect({ pool }),
	})
}
