-- Screening output-validation layer (architecture §4.6 layer 3,
-- VAL-SCAN-006 / 007 / 017).
--
-- Version: 0007_output_validation
-- Purpose: record the result of running each pack's own
-- validators against the dry-run output, enforcing that the
-- actual writes are a subset of the manifest's declared
-- filePatterns, and running the declared output toolchain
-- (currently `tsc --noEmit` for TypeScript scaffolds).
--
-- Design choices:
--   - The `output_validation` jsonb column carries a discriminated
--     payload:
--       - `{ ok: true, validators: { packValidators, recipeValidators },
--                toolchains: [...], writesSubset: true }` on pass
--       - `{ ok: false, step: "validator"|"writes-subset"|"toolchain",
--                failure: <diagnostics> }` on fail
--     The `step` discriminator names which sub-layer failed so the
--     read surface can render an honest verdict text and the
--     validator never has to guess between "the validator said no"
--     and "the toolchain said no".
--   - UPSERT semantics on `version_id` are inherited from the
--     existing `screening_results` UNIQUE constraint. The
--     static-scan + dry-run + output-validation row is rewritten
--     atomically by `writeScreeningResult` so the row's `verdict`,
--     `static_scan`, `dry_run`, and `output_validation` fields
--     stay in lock-step.
--   - The CHECK constraint on `verdict` is unchanged: the column
--     does not narrow the verdict space; layer 3 only changes which
--     value the screening record ends up with on pass/fail.

ALTER TABLE screening_results
  ADD COLUMN IF NOT EXISTS output_validation JSONB;

-- Record this migration as applied (the applyMigrations runner
-- also writes this row, but recording it inline keeps the
-- migration history observable when the SQL is replayed manually
-- for recovery).
INSERT INTO app_migrations (version)
VALUES ('0007_output_validation')
ON CONFLICT (version) DO NOTHING;
