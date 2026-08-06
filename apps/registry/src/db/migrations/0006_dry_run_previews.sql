-- Sandboxed dry-run feature (architecture §4.6, decision 6/7).
--
-- Version: 0006_dry_run_previews
-- Purpose: record the per-action outcome of the sandboxed dry-run
-- layer so the catalog read surface can serve preview artifacts
-- (one row per (version_id, action_id)) and the screening_results
-- row can carry the per-action verdict in its `dry_run` jsonb column.
--
-- Design choices:
--   - Per-action row, not per-version: the dry-run runs every
--     non-reasoning action in its own subprocess (spawn isolation),
--     so each action has its own outcome (screened / needs-llm /
--     failed / timed-out). Aggregating to a single row would hide
--     the per-action state the read surface needs to render the
--     preview list.
--   - UNIQUE (version_id, action_id) so a re-run of the dry-run
--     overwrites the previous row via the UPSERT helper.
--   - CHECK constraint pins the four documented states; future
--     values (e.g. "validator-failed") land in a separate column or
--     table when they ship.
--   - `files` is jsonb (not a relation): each preview file is
--     addressed by the storage key (a sha256), so duplicating the
--     bytes into a relational table would just double the storage
--     cost. The storage adapter is the source of truth for the
--     bytes; this row holds the metadata.
--   - `error` is TEXT (not jsonb): the dry-run surface errors are
--     single-string diagnostics (e.g. the `ERR_ACCESS_DENIED`
--     message from `--permission`), not structured payloads.
--   - `timed_out_at` is TIMESTAMPTZ so the `dry_run.timedOutAt`
--     field on the screening record and the per-action row are
--     both ISO timestamps that round-trip cleanly through jsonb.

CREATE TABLE IF NOT EXISTS screening_previews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id UUID NOT NULL REFERENCES module_versions(id) ON DELETE CASCADE,
  action_id VARCHAR(64) NOT NULL,
  state VARCHAR(16) NOT NULL CHECK (state IN ('rendered', 'needs-llm', 'failed', 'timed-out')),
  files JSONB,
  error TEXT,
  timed_out_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT screening_previews_version_action_uniq UNIQUE (version_id, action_id)
);

-- Record this migration as applied (the applyMigrations runner also
-- writes this row, but recording it inline keeps the migration
-- history observable when the SQL is replayed manually for recovery).
INSERT INTO app_migrations (version)
VALUES ('0006_dry_run_previews')
ON CONFLICT (version) DO NOTHING;
