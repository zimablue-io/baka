# Audit: apps/api, apps/landing, docs-vs-reality

Date: 2026-07-27. Auditor: adversarial subagent. Scope: AUDIT ONLY, no files modified.
Method: full source read, `pnpm vitest run` in apps/api, live server on :4310 (via
`@hono/node-server` shim in /tmp, since the api has no dev server), curl of every route,
DNS/HTTP checks on api.baka.foo and baka.foo, `pnpm build` in apps/landing, read of
README.md, SKILL.md, docs/*.md, .github/workflows/ci.yml.

Classification: BROKEN / STUB / DEAD / UNTESTED / OVER-ENGINEERED / DOCS-DRIFT / SOLID.

---

## 1. apps/api

### 1.1 Test suite — SOLID

`cd apps/api && pnpm vitest run`: 7 files, 51 tests, all pass in ~450ms.
Coverage: schema (19), aggregate (12), modules (7), built-in (6), data-files (3),
healthz (2), verified (2). Aggregate tests include injected-failure paths.

### 1.2 Live route behavior — SOLID (semantics), honest errors

Served the app on :4310 and curled every route. Real outputs:

- `GET /healthz` -> `{"status":"ok"}`
- `GET /v1/built-in` -> 200, `cache-control: public, max-age=3600`, modules
  `['baka-base','ts-style']`, both `tier: "built-in"`. Note: sdd absent (see 1.4).
- `GET /v1/built-in/sdd` -> 404 `{"error":"module not found: sdd"}`
- `GET /v1/built-in/baka-base` -> 200, full entry with `tier: "built-in"`
- `GET /v1/verified` -> 200 `{"catalogs":[]}`
- `POST /v1/aggregate` bad JSON -> 400 `{"error":"invalid JSON body"}`
- `POST /v1/aggregate` `{"catalogs":["https://nonexistent.invalid/catalog.json"]}` ->
  200 `{"modules":[],"catalogErrors":[{"url":...,"error":"fetch failed"}]}` in 77ms.
  Honest: failed catalogs are reported, not silently dropped (src/routes/aggregate.ts:60-74).
- `POST /v1/aggregate` on a real-but-wrong URL -> `catalogErrors: HTTP 404 Not Found`. Honest.
- Self-fetch (`/v1/built-in` as a catalog URL) works and tags the same modules
  `tier: "community"` — consistent with the documented tier model.
- `GET /v1/modules/:name` resolves built-in first, skips unreachable catalogs
  (`continue` on fetch failure, src/routes/modules.ts:60-64), 404s cleanly.

Verdict on aggregate/modules honesty: the code does what the doc comments say.

### 1.3 Dev server — BROKEN

`pnpm dev` = `tsx watch src/index.ts` (apps/api/package.json:13). src/index.ts:20-34
only constructs and default-exports the Hono app; there is no `serve()` call anywhere
in the package. Verified: running `npx tsx src/index.ts` exits silently, no listener on
any port, empty log. There is NO way to run this API locally without writing your own
adapter (I had to import `@hono/node-server` from the pnpm store in a /tmp shim).
For an app whose entire purpose is to serve HTTP, the dev path is dead.

### 1.4 Data drift: built-in.json vs modules/ — BROKEN (drift, uncaught)

- modules/ contains THREE modules: baka-base, ts-style, sdd
  (modules/sdd/manifest.ts exists, 2 actions: init-constitution, create-feature).
- src/data/built-in.json lists TWO (baka-base, ts-style). sdd is missing.
  Confirmed live: `/v1/built-in/sdd` -> 404.
- Content drift on ts-style: modules/ts-style/manifest.ts:5-6 says "block `any`,
  warn on console.log" (backticks); built-in.json says "block any, warn on console.log"
  (no backticks). The lint action description also differs: manifest.ts:22-23 admits
  "Stub for Phase 6; full impl wires the validator chain in Phase 8"; built-in.json
  ships the cleaned-up "Run the project's linter (biome) and report findings."
- Nothing catches this. test/data-files.test.ts validates built-in.json against the
  Zod schema only; it never compares against modules/*/manifest.ts. docs/CATALOG-FORMAT.md:183
  admits it: "For v1, the built-in catalog is hand-maintained. A future CI step
  (out of scope) could generate it from modules/*/manifest.ts to prevent drift."
  The drift the doc warns about has already happened.

### 1.5 verified.json — STUB

src/data/verified.json is `{"catalogs": []}`. The whole `verified` tier
(src/lib/tier.ts, /v1/verified, the verified branch of aggregate) is live code
serving an empty list. The "Getting a catalog verified" flow in
docs/CATALOG-FORMAT.md:118-128 has never been exercised.

### 1.6 Deployment — DEAD

- `dig +short api.baka.foo` -> empty; `curl https://api.baka.foo/healthz` ->
  exit 6 (could not resolve host). `baka.foo` likewise does not resolve.
- vercel.json (apps/api/vercel.json) configures an edge function, but there is no
  `.vercel` project link, no deploy step in .github/workflows/ci.yml, and no deploy
  runbook in README.md or docs/PUBLISHING.md (PUBLISHING covers npm only).
- Consequence: every consumer that defaults to the API is broken out of the box
  (see section 2).
- The `$schema` URL in built-in.json:2 (`https://baka.foo/schemas/catalog.v1.json`)
  and the docs (CATALOG-FORMAT.md:17) is a dead URL; editor autocomplete can never work.
- built-in.json:8 homepage `https://github.com/lefamoffat/baka/tree/main/modules`
  returns 404 (repo lives at zimablue-io/baka; lefamoffat/baka does not redirect).

### 1.7 Schema design — SOLID (worth keeping)

src/lib/schema.ts:64 `ModuleEntrySchema = ModuleManifestSchema.extend({...})` reuses
the protocol SSOT instead of duplicating manifest fields. Compared against
packages/protocol/src/schemas.ts (name, version, description, dependencies,
conflictsWith, actions.min(1), moduleValidators): zero field drift; the api only adds
marketplace fields (source, author, license, tags, category, keywords, icon, accent)
and the server-attached tier enum (schema.ts:41-42). This is the right contract to
carry into the registry.

### 1.8 Cache — SOLID but speculative

src/lib/cache.ts TTLCache is fine for what it is, but it exists to absorb "hot-path
traffic" on an API with zero traffic and zero deployment. Harmless; keep the class,
drop the rationale comments about Vercel Edge regions if the edge story dies.

---

## 2. CLI coupling to the dead API — BROKEN by default

- apps/cli/src/lib/marketplace-client.ts:15 `DEFAULT_API_URL = "https://api.baka.foo"`.
  Only override is the `BAKA_API_URL` env var (marketplace-client.ts:17-19). The
  comment at line 10 even says "The default will be updated once the production
  domain is decided" — it never was.
- `baka search <q>` (apps/cli/src/commands/search.ts:47-49) calls
  `getBuiltInCatalog()` with no try/catch -> DNS failure -> unhandled throw.
  Hard failure out of the box.
- `baka install <bare-name>` (apps/cli/src/commands/marketplace.ts:42-53) wraps the
  lookup in try/catch and returns null -> clean USER_ERROR. Graceful.
  Two commands, two opposite failure modes against the same dead host.
- `baka marketplace update` is a documented no-op: marketplace.ts:200 "v1: no-op."
  STUB.
- apps/cli/package.json:26 declares `"@baka/api": "workspace:*"` — the CLI depends on
  an *app* for four response types. App-to-app dependency; the wire contract belongs
  in packages/ (protocol or a new registry-contract package), especially once the
  CLI tarball ships to npm where workspace apps are an odd thing to bundle.

---

## 3. apps/landing

### 3.1 Build — SOLID

`cd apps/landing && pnpm build` (tsc --noEmit && vite build): clean, 92 modules,
220.5 kB JS (70 kB gzip), built in 81ms. No type errors.

### 3.2 Tests — UNTESTED

No test script, no test files, no vitest config (apps/landing/package.json has only
dev/build/preview/check-types/lint). The catalog search filter in ModuleCatalog.tsx
is untested UI logic.

### 3.3 Catalog drift — BROKEN (same drift as the API, third copy)

src/data/modules.ts lists baka-base and ts-style only. sdd missing. The file's own
header comment says "Update when new modules land" — sdd landed (June 26 per git)
and nobody updated it. This is the THIRD hand-maintained copy of the module list
(built-in.json, modules.ts, and the real modules/ directory), and two of three
have drifted the same way. Description strings are also reworded copies, not quotes
of the manifests.

### 3.4 Claims vs reality — DOCS-DRIFT / dishonesty-by-omission

- ModuleCatalog.tsx:62 "Modules shipped with the engine." -> shows 2 of 3.
- ModuleCatalog.tsx:92-96 "A community marketplace is coming." -> apps/api IS the
  marketplace and it exists in-repo; it is simply never deployed. The landing page
  describes a future that is actually a stalled present.
- Hero.tsx:26-28 "Same intent, same modules, same plan, every time, on every model."
  The determinism machinery (temperature 0.0 default at packages/agent-engine/src/index.ts:90,208;
  5x consistency test in the module-design flow) exists, but "on every model" is
  unverifiable marketing and there is no CI-level determinism test (it needs a live LLM).
- src/lib/site.ts:9 GITHUB_OWNER = "zimablue-io" — CORRECT (200). But README.md:31
  uses `zimablue/baka` (404) and built-in.json:8 uses `lefamoffat/baka` (404).
  Three surfaces, three GitHub identities, two of them dead.
- All footer/header doc links (SiteFooter.tsx:5-8) resolve to files that exist
  (docs/PHILOSOPHY.md, MODULES.md, AGENT.md) — fine.
- GetStarted.tsx clone URL uses SITE.github.cloneUrl (zimablue-io) — correct,
  unlike the README.

---

## 4. Docs coherence

### 4.1 README.md

- BROKEN: line 31 `git clone https://github.com/zimablue/baka.git` -> 404 (verified
  via curl; correct org is zimablue-io). The very first instruction in the repo
  fails for a new user.
- DOCS-DRIFT: "Directory Architecture" (lines 176-196) omits apps/api, apps/landing,
  packages/baka-sdk, packages/typescript-config, scripts/, dist-tarballs/. It also
  describes docs/ as "Philosophy, agent guide, specs" — no specs live in docs/.
- Quickstart (lines 95-100) claims `baka list-modules` finds 3 modules incl. sdd —
  TRUE against modules/, FALSE against the marketplace surfaces. The README is the
  only surface that got this right.
- README never mentions apps/api, apps/landing, `baka search`, or `baka marketplace`
  at all. Two apps and six CLI commands are undocumented in the primary doc.

### 4.2 docs/ARCHIVE.md — BROKEN (the archive's successor does not exist)

- Claims docs/PRD.md and docs/ROADMAP.md were archived "in favor of canonical
  successors living under specs/" with forward links to specs/mission.md and
  specs/roadmap.md. **There is no specs/ directory** (`ls specs` -> NO specs/ dir).
  The archive points at a void: the old docs were deleted and the replacement was
  never created (or was itself deleted).
- References "the validation contract VAL-DOC-014" that "gates this archive".
  Grep for VAL-DOC-014 across the repo: the only hit is ARCHIVE.md itself. The
  gate does not exist either.
- Note: modules/sdd's whole job is to create specs/ in *target projects*
  (modules/sdd/manifest.ts:14) — but baka itself does not eat its own cooking.

### 4.3 docs/AGENT.md — DOCS-DRIFT

- Line 88: "The current source of truth for each phase is
  docs/superpowers/specs/2026-06-15-baka-redesign.md" — docs/superpowers/ does not
  exist.
- Lines 34-40 (and PHILOSOPHY.md "The grep test"): the provider-boundary grep
  `grep -rE "fetch\(|https?://|api\.openai|anthropic" packages/ workflows/ apps/
  --include="*.ts" | grep -v "agent-engine/"` "MUST return zero matches". Actual run
  today: 6 files match — packages/ast-tooling/src/package-manager.ts (source-string
  parsing), workflows/module-management design files (comment URLs),
  apps/landing/src/lib/site.ts, apps/cli/src/lib/marketplace-client.ts,
  apps/cli/src/commands/init.ts (DEFAULT_BASE_URL). None are LLM-provider leaks, but
  the literal test the docs demand has been failing since the marketplace landed.
  The invariant is real; the test as written is wrong (needs an allowlist or a
  narrower pattern). DOCS-DRIFT.

### 4.4 docs/CATALOG-FORMAT.md — DOCS-DRIFT (features described that were never built)

- Lines 121-123: "CI fetches your URL, validates the response, and rejects the PR if
  the catalog is malformed or unreachable." FALSE. ci.yml's validate-marketplace-data
  job only runs `pnpm --filter @baka/api run test`, which schema-validates the local
  files. Nothing fetches anything. The promised verification gate does not exist.
- Trust-tier table (lines 108-116): "The landing app defaults to built-in + verified
  and surfaces community only in a separate 'Your catalogs' section." FALSE. The
  landing app has no tiers, no community section, no "Your catalogs" — it is a static
  table from a hardcoded file. The described landing app was never built.
- Line 183 (hand-maintained built-in, drift warning) — see 1.4; the predicted drift
  is here.

### 4.5 docs/PUBLISHING.md — SOLID with one stale expectation

The npm runbook is detailed and matches reality (scripts/release.sh, scripts/pack.mjs,
no publish in CI — confirmed against ci.yml). Preflight step 6 expects
`baka list-modules --json | jq '.modules | length'` = 3 — consistent with modules/
(and inconsistent with the API/landing, again).

### 4.6 docs/PHILOSOPHY.md + SKILL.md — mostly SOLID, one UNTESTED pillar

- "The same intent + the same modules always produce the same plan" is the load-bearing
  claim of the whole project (README:4, SKILL.md invariants, Hero.tsx). Evidence:
  temperature defaults to 0.0 (agent-engine/src/index.ts:90), module-design runs a
  5x hash-equality consistency test (apps/cli/src/commands/module-design/consistency),
  but nothing in CI tests plan determinism (it requires a live LLM). UNTESTED at the
  level the marketing states it.
- SKILL.md's module/CLI/MCP descriptions match the actual command surface
  (baka_plan/apply/validate/list_actions, module create/validate/test/list-actions).
- Process rule ("Ship what's needed for the current task... No v0 stubs") vs reality:
  apps/api is a deployed-nowhere v1 with an empty verified tier, a no-op
  `marketplace update`, and a `Phase 6 stub` comment still live in
  modules/ts-style/lint/action.ts:29-31. The rule is stated; the repo violates it.

### 4.7 .github/workflows/ci.yml — SOLID (does what it says)

validate-marketplace-data gate + full-test (lint, check-types, test, build, pack,
knip advisory, tarball+stdio smoke). Honest comments. Gaps: never builds/apps the
landing explicitly (it is covered transitively by `pnpm build` via turbo), never
deploys the API, and the "CI validates verified catalogs by fetching them" story in
CATALOG-FORMAT is fiction (4.4).

---

## 5. Judgment: apps/api vs the new registry

What apps/api actually is today: a well-tested, honest, stateless read-path over two
hand-maintained JSON files, with a good schema contract, deployed nowhere, serving a
dead domain, drifted from the module source of truth, and holding the CLI hostage via
a broken default URL and an app-to-app dependency.

Keeping BOTH an edge api.baka.foo AND a new DB-backed registry server is not coherent:
they would be two read-paths over the same logical data with two deployment stories,
and the project has already demonstrated it cannot keep even ONE deployment alive
(plus three copies of the module list). One must subsume the other, and the DB-backed
registry is the one with a future.

What to salvage:
- **The schema contract** (src/lib/schema.ts): ModuleEntrySchema/CatalogSchema/
  ApiModuleEntrySchema/tier enum/aggregate request-response shapes. This is the real
  asset. Move it into packages/ (protocol or packages/registry-contract) so the CLI
  stops depending on an app, and make the registry serve these exact shapes.
- **The tier semantics** (server-attached, publishers can't self-declare): correct
  design, maps 1:1 onto DB rows.
- **The aggregate error-honesty contract** (`modules` + `catalogErrors`, per-catalog
  isolation): verified live; preserve in the registry's read API.
- **TTLCache**: trivially portable if the registry keeps URL fan-out; optional.
- **The test suite structure**: route-level tests via `app.request()` port directly
  to any Hono-based registry.

What to delete without replacement:
- built-in.json and verified.json as hand-maintained files (generate from manifests
  during the migration, then the DB is the source of truth).
- vercel.json / the Vercel-edge deployment story (never existed in practice).
- The api.baka.foo default in the CLI until a real registry URL exists; meanwhile
  `baka search` should degrade gracefully like `baka install` does.

Landing page honesty: it is a polished marketing page for a project whose flagship
claim is untested in CI, whose marketplace is an undeployed app, and whose module
table is missing a third of the catalog. Either wire it to generated data and soften
the determinism sentence, or accept that it describes the aspiration, not the product.

---

## 6. Verdict table

| Surface | Verdict | One-line rationale |
|---|---|---|
| api src/lib/schema.ts (catalog/entry/tier/wire shapes) | keep (move to packages/) | Best asset in the app; reuses protocol SSOT; CLI + registry both need it |
| api routes (built-in/verified/aggregate/modules) + tests | fold-into-registry | Honest read-path semantics already proven; port onto DB, drop URL-fan-out where DB answers |
| api src/lib/cache.ts TTLCache | fold-into-registry | Works; keep only if registry keeps external catalog fetch |
| api src/data/built-in.json | cut | Hand-maintained copy; already drifted (sdd missing, descriptions reworded); DB/generation replaces it |
| api src/data/verified.json | cut | Empty file behind a never-exercised flow; becomes a DB column/table |
| api vercel.json + edge story + api.baka.foo | cut | Never deployed; domain does not resolve; two deployment stories is incoherent |
| api package.json "dev" script | fix | Currently starts nothing; add a real serve entry or delete the script |
| CLI marketplace-client default URL | fix | Dead host; `baka search` hard-fails out of the box while `baka install` degrades |
| CLI dep on `@baka/api` (apps/cli/package.json:26) | fix | App-to-app dependency for types; move wire contract to packages/ |
| CLI `marketplace update` (marketplace.ts:200) | cut | Documented no-op; reintroduce with the registry's sync story |
| landing src/data/modules.ts | cut (generate) | Third hand-maintained catalog copy, drifted the same way as built-in.json |
| landing app overall | fix | Builds clean; needs generated data, honest marketplace framing, softened determinism claim, at least a smoke test |
| README.md clone URL + directory map | fix | First instruction 404s; architecture map missing 4 packages/apps |
| docs/ARCHIVE.md | fix | Archive points at nonexistent specs/ and nonexistent VAL-DOC-014 gate |
| docs/AGENT.md grep test + superpowers ref | fix | Literal test fails on a healthy tree; referenced spec path does not exist |
| docs/CATALOG-FORMAT.md CI-fetch + landing-tier claims | fix | Describes CI fetch-validation and landing tier UI that were never built |
| docs/PUBLISHING.md, ci.yml, SKILL.md | keep | Accurate, verified against reality |
