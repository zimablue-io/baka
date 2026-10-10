import { bigint, index, integer, jsonb, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core"

/**
 * Registry app schema (architecture §4.3).
 *
 * This is the TypeScript view of the SQL migration in
 * `./migrations/0002_app_schema.sql`. The SQL is the source of truth for
 * the on-disk shape; this file is the Drizzle ORM binding so app code can
 * write `db.insert(packs).values(...)` instead of hand-rolled SQL. Both
 * MUST stay in lockstep — the migration runner applies the SQL and Drizzle
 * types/relations describe the resulting schema.
 *
 * Better-Auth manages its own tables (user / session / account /
 * organization / member / invitation / apikey) through its Kysely path.
 * They coexist in the same database but are owned by the auth feature and
 * never re-declared here.
 */

// ---------------------------------------------------------------------------
// packs
// ---------------------------------------------------------------------------

export const packs = pgTable(
	"packs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		scope: varchar("scope", { length: 64 }).notNull(),
		name: varchar("name", { length: 64 }).notNull(),
		visibility: varchar("visibility", { length: 16 }).notNull(),
		tier: varchar("tier", { length: 32 }).notNull(),
		description: text("description").notNull().default(""),
		// TEXT (not UUID) so it matches Better-Auth's user.id shape.
		// The publish endpoint records the creating user's id here so
		// the audit trail is honest. Migration 0005_publish_columns
		// changed the underlying column type from UUID to TEXT.
		createdBy: text("created_by"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
		removedAt: timestamp("removed_at", { withTimezone: true }),
	},
	(t) => ({
		scopeNameUniq: unique("packs_scope_name_uniq").on(t.scope, t.name),
	}),
)

// ---------------------------------------------------------------------------
// pack_versions
// ---------------------------------------------------------------------------

const packVersions = pgTable(
	"pack_versions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		packId: uuid("pack_id")
			.notNull()
			.references(() => packs.id, { onDelete: "cascade" }),
		version: varchar("version", { length: 64 }).notNull(),
		commitSha: varchar("commit_sha", { length: 64 }).notNull(),
		contentHash: varchar("content_hash", { length: 64 }).notNull(),
		manifest: jsonb("manifest").notNull(),
		status: varchar("status", { length: 16 }).notNull(),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		packVersionUniq: unique("pack_versions_pack_id_version_uniq").on(t.packId, t.version),
		contentHashIdx: index("pack_versions_content_hash_idx").on(t.contentHash),
	}),
)

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

const artifacts = pgTable(
	"artifacts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		versionId: uuid("version_id")
			.notNull()
			.references(() => packVersions.id, { onDelete: "cascade" }),
		kind: varchar("kind", { length: 32 }).notNull(),
		path: text("path").notNull(),
		size: bigint("size", { mode: "number" }).notNull(),
		sha256: varchar("sha256", { length: 64 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		versionKindPathUniq: unique("artifacts_version_id_kind_path_uniq").on(t.versionId, t.kind, t.path),
	}),
)

// ---------------------------------------------------------------------------
// screening_results
// ---------------------------------------------------------------------------

const screeningResults = pgTable(
	"screening_results",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		versionId: uuid("version_id")
			.notNull()
			.references(() => packVersions.id, { onDelete: "cascade" }),
		verdict: varchar("verdict", { length: 32 }).notNull(),
		staticScan: jsonb("static_scan"),
		dryRun: jsonb("dry_run"),
		outputValidation: jsonb("output_validation"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		onePerVersion: unique("screening_results_version_id_uniq").on(t.versionId),
	}),
)

// ---------------------------------------------------------------------------
// plan_limits
// ---------------------------------------------------------------------------

const planLimits = pgTable("plan_limits", {
	plan: varchar("plan", { length: 32 }).primaryKey(),
	maxPrivatePacks: integer("max_private_packs").notNull(),
	maxMembers: integer("max_members").notNull(),
	maxRegistries: integer("max_registries").notNull(),
})

// ---------------------------------------------------------------------------
// screening_previews (architecture §4.6 layer 2, dry-run)
// ---------------------------------------------------------------------------
//
// One row per (version_id, recipe_id). Carries the per-recipe outcome
// of the sandboxed dry-run (rendered / needs-llm / failed / timed-out),
// the preview file metadata (when state='rendered'), and the surface
// error string (when state='failed' / 'timed-out'). UPSERT semantics
// on (version_id, recipe_id) so a re-run overwrites the previous row
// cleanly; the storage adapter is the source of truth for the preview
// file bytes (this row stores the key, not the bytes).

const screeningPreviews = pgTable(
	"screening_previews",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		versionId: uuid("version_id")
			.notNull()
			.references(() => packVersions.id, { onDelete: "cascade" }),
		recipeId: varchar("recipe_id", { length: 64 }).notNull(),
		state: varchar("state", { length: 16 }).notNull(),
		files: jsonb("files"),
		error: text("error"),
		timedOutAt: timestamp("timed_out_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		versionRecipeUniq: unique("screening_previews_version_recipe_uniq").on(t.versionId, t.recipeId),
	}),
)

// ---------------------------------------------------------------------------
// app_migrations (internal tracking; not part of architecture §4.3)
// ---------------------------------------------------------------------------
//
// Lives next to the on-disk `schema_version` file. The on-disk file gates
// the registry binary's schema (forward-only); this table records which
// SQL migrations have been applied so the SQL itself can be re-applied
// idempotently against an upgraded binary.

const appMigrations = pgTable("app_migrations", {
	version: text("version").primaryKey(),
	appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
})

export const schema = {
	packs,
	packVersions,
	artifacts,
	screeningResults,
	screeningPreviews,
	planLimits,
	appMigrations,
}
