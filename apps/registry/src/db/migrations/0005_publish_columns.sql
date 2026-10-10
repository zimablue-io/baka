-- Publish-endpoint feature (architecture §4.5, decision 30).
--
-- Version: 0005_publish_columns
-- Purpose: align the `packs.created_by` column with Better-Auth's
-- `user.id` shape. The original migration (0002) declared the column
-- as UUID, which assumed the registry's own user id namespace; in
-- practice the registry uses Better-Auth's organization + member
-- tables, whose ids are non-UUID strings. The publish endpoint now
-- records the creating user's id so the audit trail is honest
-- (which identity caused this row to exist).
--
-- Design choices:
--   - TYPE change (UUID → TEXT) so the column can hold Better-Auth's
--     arbitrary id shape. TEXT is the same shape used by
--     Better-Auth's own `user.id`, `member.userId`, and
--     `organization.id` columns, so the data lines up directly.
--   - Idempotent: a fresh boot against an empty data dir runs the
--     migration once and bakes the new shape in; an upgrade boot
--     re-applies the ALTER, which is a no-op because the columns
--     already match (the migration runner records the row in
--     `app_migrations` and skips on subsequent boots).
--   - No data backfill is needed: no `packs` rows have ever been
--     written with a populated `created_by` (the column was a UUID
--     and no real id matched that shape). Existing rows keep `NULL`.

ALTER TABLE packs
  ALTER COLUMN created_by TYPE TEXT USING created_by::text;

-- Record this migration as applied (the applyMigrations runner also
-- writes this row, but recording it inline keeps the migration
-- history observable when the SQL is replayed manually for recovery).
INSERT INTO app_migrations (version)
VALUES ('0005_publish_columns')
ON CONFLICT (version) DO NOTHING;
