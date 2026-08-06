-- Registry app schema (architecture §4.3, decision 28 forward-only).
--
-- Version: 0002_app_schema
-- Purpose: create the five app tables the registry owns (modules,
-- module_versions, artifacts, screening_results, plan_limits) plus the
-- internal migration tracking table that makes idempotent re-application
-- safe across boots.
--
-- Design choices:
--   - UUIDs for primary keys (random v4) so write throughput is not gated
--     by a sequence and so content-addressed collision is not a concern.
--   - TEXT / VARCHAR + CHECK constraints instead of ENUM types. PGlite and
--     server Postgres both handle them; CHECK makes the constraint visible
--     in information_schema.table_constraints uniformly.
--   - timestamptz everywhere (with timezone); the binary lives forever
--     and timezone-naive columns have produced real bugs across deploys.
--   - UNIQUE constraints are NOT partial (no `WHERE NOT removed`). The
--     "tombstone vs hard delete" semantics (architecture §8 decision 1)
--     land in a later milestone and will narrow the index then; for now
--     a re-published scope/name is a uniqueness violation, which the
--     publish feature must handle explicitly.
--   - jsonb for `manifest`, `static_scan`, `dry_run` so Drizzle can
--     accept arbitrary structured payloads without round-tripping through
--     a JSON-string column.
--   - ON DELETE CASCADE for child tables so a hard-removed module cleans
--     up its versions / artifacts / screenings. Tombstones (the deletion
--     path) use `removed_at` and never delete the row.
--   - `app_migrations` is the in-DB tracking table; it lives next to the
--     registry's on-disk `schema_version` file (see schema-version.ts) but
--     records which app migrations have been applied. The two are kept in
--     sync: any new bump to CURRENT_SCHEMA_VERSION adds a row here in the
--     same SQL block.

CREATE TABLE IF NOT EXISTS app_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- modules (architecture §4.3)
-- ---------------------------------------------------------------------------
CREATE TABLE modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope VARCHAR(64) NOT NULL,
  name VARCHAR(64) NOT NULL,
  visibility VARCHAR(16) NOT NULL,
  tier VARCHAR(32) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at TIMESTAMPTZ,
  CONSTRAINT modules_scope_name_uniq UNIQUE (scope, name),
  CONSTRAINT modules_visibility_check CHECK (visibility IN ('public', 'org')),
  CONSTRAINT modules_tier_check CHECK (
    tier IN ('official', 'verified', 'community-screened', 'community-unverified')
  )
);

-- ---------------------------------------------------------------------------
-- module_versions (architecture §4.3)
-- ---------------------------------------------------------------------------
CREATE TABLE module_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id UUID NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  version VARCHAR(64) NOT NULL,
  commit_sha VARCHAR(64) NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  manifest JSONB NOT NULL,
  status VARCHAR(16) NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT module_versions_module_id_version_uniq UNIQUE (module_id, version),
  CONSTRAINT module_versions_status_check CHECK (
    status IN ('pending', 'ingesting', 'ready', 'failed')
  )
);

CREATE INDEX module_versions_content_hash_idx ON module_versions (content_hash);

-- ---------------------------------------------------------------------------
-- artifacts (architecture §4.3)
-- ---------------------------------------------------------------------------
CREATE TABLE artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id UUID NOT NULL REFERENCES module_versions(id) ON DELETE CASCADE,
  kind VARCHAR(32) NOT NULL,
  path TEXT NOT NULL,
  size BIGINT NOT NULL,
  sha256 VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT artifacts_version_id_kind_path_uniq UNIQUE (version_id, kind, path),
  CONSTRAINT artifacts_kind_check CHECK (kind IN ('tarball', 'preview'))
);

-- ---------------------------------------------------------------------------
-- screening_results (architecture §4.3)
-- ---------------------------------------------------------------------------
CREATE TABLE screening_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id UUID NOT NULL REFERENCES module_versions(id) ON DELETE CASCADE,
  verdict VARCHAR(32) NOT NULL,
  static_scan JSONB,
  dry_run JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT screening_results_version_id_uniq UNIQUE (version_id),
  CONSTRAINT screening_results_verdict_check CHECK (
    verdict IN ('screened', 'unverified', 'failed')
  )
);

-- ---------------------------------------------------------------------------
-- plan_limits (architecture §4.3, decision 3 monetization seam)
-- ---------------------------------------------------------------------------
CREATE TABLE plan_limits (
  plan VARCHAR(32) PRIMARY KEY,
  max_private_modules INTEGER NOT NULL,
  max_members INTEGER NOT NULL,
  max_registries INTEGER NOT NULL,
  CONSTRAINT plan_limits_plan_check CHECK (plan IN ('free', 'pro'))
);

-- Seed the documented default plans so plan-limit enforcement has a lookup
-- before the REGISTRY_SEED_PLANS hook (architecture §8 decision 3) can
-- overwrite them. ON CONFLICT DO NOTHING keeps this idempotent across
-- migrations and against operator-supplied overrides.
INSERT INTO plan_limits (plan, max_private_modules, max_members, max_registries)
VALUES
  ('free', 5, 3, 1),
  ('pro', 100, 25, 10)
ON CONFLICT (plan) DO NOTHING;

-- Record this migration as applied (the applyMigrations runner also writes
-- this row, but recording it inline keeps the contract observable when the
-- SQL is replayed manually for recovery).
INSERT INTO app_migrations (version)
VALUES ('0002_app_schema')
ON CONFLICT (version) DO NOTHING;
