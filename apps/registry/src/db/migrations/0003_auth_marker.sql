-- Auth layer marker migration (architecture §4.4).
--
-- Version: 0003_auth_marker
-- Purpose: signal the schema version bump that introduced Better-Auth's
-- own tables. Better-Auth manages user / session / account / verification /
-- organization / member / invitation / apikey through its Kysely
-- migration path; this file is a no-op marker so the registry binary's
-- forward-only schema-version gate (decision 28) records the bump and
-- `applyAppMigrations` can advance the `app_migrations` row.
--
-- The actual auth-table DDL is applied at boot by
-- `auth/ensure-auth-tables.ts` using Better-Auth's `getMigrations`
-- introspection. That path is itself idempotent (it inspects the live
-- schema before issuing CREATE statements), so a re-run after a crash or
-- against an already-bootstrapped data dir is a no-op.
--
-- Recording this row inline keeps the migration history observable when
-- the SQL is replayed manually for recovery.
INSERT INTO app_migrations (version)
VALUES ('0003_auth_marker')
ON CONFLICT (version) DO NOTHING;
