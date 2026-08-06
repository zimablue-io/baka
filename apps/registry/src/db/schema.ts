import { bigint, index, integer, jsonb, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core"

/**
 * Registry app schema (architecture §4.3).
 *
 * This is the TypeScript view of the SQL migration in
 * `./migrations/0002_app_schema.sql`. The SQL is the source of truth for
 * the on-disk shape; this file is the Drizzle ORM binding so app code can
 * write `db.insert(modules).values(...)` instead of hand-rolled SQL. Both
 * MUST stay in lockstep — the migration runner applies the SQL and Drizzle
 * types/relations describe the resulting schema.
 *
 * Better-Auth manages its own tables (user / session / account /
 * organization / member / invitation / apikey) through its Kysely path.
 * They coexist in the same database but are owned by the auth feature and
 * never re-declared here.
 */

// ---------------------------------------------------------------------------
// modules
// ---------------------------------------------------------------------------

export const modules = pgTable(
	"modules",
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
		scopeNameUniq: unique("modules_scope_name_uniq").on(t.scope, t.name),
	}),
)

type ModuleRow = typeof modules.$inferSelect
type NewModuleRow = typeof modules.$inferInsert

// ---------------------------------------------------------------------------
// module_versions
// ---------------------------------------------------------------------------

const moduleVersions = pgTable(
	"module_versions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		moduleId: uuid("module_id")
			.notNull()
			.references(() => modules.id, { onDelete: "cascade" }),
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
		moduleVersionUniq: unique("module_versions_module_id_version_uniq").on(t.moduleId, t.version),
		contentHashIdx: index("module_versions_content_hash_idx").on(t.contentHash),
	}),
)

type ModuleVersionRow = typeof moduleVersions.$inferSelect
type NewModuleVersionRow = typeof moduleVersions.$inferInsert

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

const artifacts = pgTable(
	"artifacts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		versionId: uuid("version_id")
			.notNull()
			.references(() => moduleVersions.id, { onDelete: "cascade" }),
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

type ArtifactRow = typeof artifacts.$inferSelect
type NewArtifactRow = typeof artifacts.$inferInsert

// ---------------------------------------------------------------------------
// screening_results
// ---------------------------------------------------------------------------

const screeningResults = pgTable(
	"screening_results",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		versionId: uuid("version_id")
			.notNull()
			.references(() => moduleVersions.id, { onDelete: "cascade" }),
		verdict: varchar("verdict", { length: 32 }).notNull(),
		staticScan: jsonb("static_scan"),
		dryRun: jsonb("dry_run"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		onePerVersion: unique("screening_results_version_id_uniq").on(t.versionId),
	}),
)

type ScreeningResultRow = typeof screeningResults.$inferSelect
type NewScreeningResultRow = typeof screeningResults.$inferInsert

// ---------------------------------------------------------------------------
// plan_limits
// ---------------------------------------------------------------------------

const planLimits = pgTable("plan_limits", {
	plan: varchar("plan", { length: 32 }).primaryKey(),
	maxPrivateModules: integer("max_private_modules").notNull(),
	maxMembers: integer("max_members").notNull(),
	maxRegistries: integer("max_registries").notNull(),
})

type PlanLimitRow = typeof planLimits.$inferSelect
type NewPlanLimitRow = typeof planLimits.$inferInsert

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

type AppMigrationRow = typeof appMigrations.$inferSelect

const schema = {
	modules,
	moduleVersions,
	artifacts,
	screeningResults,
	planLimits,
	appMigrations,
}
