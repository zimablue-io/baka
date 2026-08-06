-- Monetization seams: `orgs.plan` and open-ended plan set
-- (architecture §4.7, decision 3).
--
-- Version: 0004_orgs_plan
-- Purpose:
--   (a) Extend Better-Auth's `organization` table with a `plan` column
--       so the registry can enforce per-plan limits without exposing
--       any billing surface. The plan is server-attached (seeded at
--       boot via `REGISTRY_SEED_PLANS`) and there is no public API
--       to change it (decision 3, VAL-AUTH-017). Defaults to `free`
--       so every existing org created before this migration lands on
--       the documented baseline.
--   (b) Broaden the `plan_limits` CHECK constraint so operators can
--       add plans beyond `free`/`pro` via `REGISTRY_SEED_PLANS`.
--       The migration-0002 strict check would otherwise reject any
--       new plan an operator wants to ship.
--
-- Design choices:
--   - DO-block guard so the `organization` ALTER runs only when
--     Better-Auth's table is already present. App migrations run
--     BEFORE Better-Auth's `ensureTables()`, so on a fresh boot the
--     table does not yet exist; the DO block is a no-op in that
--     window. Better-Auth creates the table on its next pass; the
--     SAME migration replays idempotently against the now-present
--     table and adds the column + constraint. A second boot is a
--     no-op (the IF NOT EXISTS and the constraint existence check
--     short-circuit).
--   - VARCHAR(32) + CHECK constraint pin the `plan` column's closed
--     set on the org table. Adding a plan requires a new migration
--     (or a `REGISTRY_SEED_PLANS` override at boot, applied through
--     `applySeedPlans`).
--   - The `plan_limits` CHECK constraint widens to allow any plan
--     name that matches a slug pattern (lowercase letter, then
--     alphanum / dash / underscore, 1..32 chars). DROP IF EXISTS +
--     ADD CONSTRAINT is idempotent because both halves guard on
--     existence.
--   - DEFAULT 'free' so existing rows and new INSERTs that omit the
--     column land on the documented baseline.
--   - The schema-version gate (decision 28) is bumped by editing
--     CURRENT_SCHEMA_VERSION in `schema-version.ts`; this file only
--     holds the SQL. Better-Auth's introspection (`getMigrations`)
--     is read-only on extra columns it does not own — it never DROPs
--     them and never issues CREATE TABLE for tables it finds, so the
--     ALTER coexists with the auth layer's own ensureTables() call.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'organization'
  ) THEN
    ALTER TABLE "organization"
      ADD COLUMN IF NOT EXISTS "plan" VARCHAR(32) NOT NULL DEFAULT 'free';

    IF NOT EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conname = 'organization_plan_check'
         AND conrelid = 'organization'::regclass
    ) THEN
      ALTER TABLE "organization"
        ADD CONSTRAINT "organization_plan_check"
        CHECK ("plan" IN ('free', 'pro', 'enterprise', 'team'));
    END IF;
  END IF;
END
$$;

-- Broaden the plan_limits CHECK constraint to allow operator-defined
-- plans beyond the migration-0002 strict `free`/`pro` set. The
-- application-level `applySeedPlans` zod schema already enforces the
-- same shape; the CHECK keeps the DB honest against ad-hoc writes.
ALTER TABLE "plan_limits"
  DROP CONSTRAINT IF EXISTS "plan_limits_plan_check";

ALTER TABLE "plan_limits"
  ADD CONSTRAINT "plan_limits_plan_check"
  CHECK ("plan" ~ '^[a-z][a-z0-9_-]{0,31}$');

-- Record this migration as applied. `applyMigrations` also writes the
-- row, but recording it inline keeps the migration history observable
-- when the SQL is replayed manually for recovery.
INSERT INTO app_migrations (version)
VALUES ('0004_orgs_plan')
ON CONFLICT (version) DO NOTHING;
