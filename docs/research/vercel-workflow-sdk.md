# Vercel Workflow SDK ("workflow" npm package) — Research for baka registry ingest jobs

Date: 2026-07-27
Researcher: subagent (worker)
Question: Can the `workflow` npm package power durable ingest jobs (git clone → schema validation → AST scan + sandboxed `node --permission` dry-run → preview artifacts → Postgres write) for both the hosted hub and self-hosted OSS installs of the baka module registry?

The baka repo root already depends on `"workflow": "^4.4.0"` (currently unused).

---

## 1. What the package is (2026 state)

- The `workflow` npm package is Vercel's **Workflow SDK** (renamed from "Workflow DevKit" ~Mar 2026). Open source (Apache-2.0), repo `github.com/vercel/workflow`, docs at `workflow-sdk.dev` (also `useworkflow.dev` mirror).
- Maturity: announced Oct 23 2025 as public beta; **Vercel Workflows is now GA** (blog post 2026-04-16, "100M+ runs in beta across 1,500+ customers"). Repo has 2.3k stars, 505 releases, latest `workflow@4.6.2` (2026-07-24), 108 contributors, very active (commits 2 days before this writing). A 5.0.0-beta line exists (multi-region Vercel world).
- Core concepts:
  - **Workflow function** (`"use workflow"` directive): the orchestrator. Runs in a **sandboxed, deterministic runtime without full Node.js access**; npm package use is limited. Re-run (replayed) multiple times against an event log; must be deterministic (`Date`, `Math.random` are fixed by the framework).
  - **Step function** (`"use step"` directive): does the actual work. **Full Node.js runtime and npm access.** Automatic retries, results persisted to the event log for replay. Default `maxRetries = 3` (4 total attempts); `FatalError` skips retries; `RetryableError` customizes delay. Steps must be idempotent because external side effects can repeat.
  - **Durability**: event-sourced event log; workflow suspends (no compute used) while waiting on steps / `sleep()` / webhooks, then resumes by replaying the log.
  - **Worlds**: pluggable backend abstraction for storage + queue + streaming. `WORKFLOW_TARGET_WORLD` env var selects it.
- Requires a **build-time code transform** (SWC plugin / bundler integration) to compile the directives. Framework integrations: Next.js, SvelteKit, Nuxt, Nitro, Vite, Astro, and — relevant to us — **Hono via `workflow/nitro`** (the Hono getting-started guide wraps the Hono app in Nitro with `modules: ["workflow/nitro"]`, plus `nitro` and `rollup` as deps). There is no "run plain Node without a bundler" path documented; the directive transform is mandatory.

Sources:
- https://github.com/vercel/workflow
- https://vercel.com/blog/a-new-programming-model-for-durable-execution (GA, 2026-04-16)
- https://vercel.com/changelog/open-source-workflow-dev-kit-is-now-in-public-beta
- https://workflow-sdk.dev/docs/foundations/workflows-and-steps
- https://workflow-sdk.dev/docs/getting-started/hono
- https://www.npmjs.com/package/workflow

## 2. Deployment portability (the critical question)

**Yes, it runs outside Vercel.** The Worlds abstraction is explicitly designed for this ("The World abstraction allows workflows to run anywhere — locally, on Vercel, or on any cloud").

Worlds available (https://workflow-sdk.dev/worlds):

- **Local** (`@workflow/world-local`, bundled with `workflow`): zero-config, used automatically in dev. Stores data as JSON files in `.workflow-data/`, **in-memory queue — jobs do not persist across restarts**, single instance, dev-only.
- **Postgres** (`@workflow/world-postgres`, official, v4.1.0): "**Production-ready**, self-hosted world using PostgreSQL for durable storage and **graphile-worker** for reliable job processing." Uses Drizzle ORM + pg tables for runs/events/steps, graphile-worker for the queue, LISTEN/NOTIFY for streaming. Requires a **long-lived worker process** (polls the DB) — explicitly **not compatible with serverless**, explicitly **not compatible with Vercel deployments** (use Vercel world there). Bootstrap via `npx --package=@workflow/world-postgres bootstrap` (idempotent migration). 100% spec e2e pass (289/289 on Next.js prod config; 1877 passed / 0 failed across all framework configs). Config: `WORKFLOW_POSTGRES_URL` (falls back to `DATABASE_URL`), worker concurrency default 50.
- **Vercel** (`@workflow/world-vercel`): zero-config on Vercel deploy; uses Vercel Queues + Vercel storage; e2e encrypted. On 4.x, all workflow data lives in `iad1` regardless of app region.
- Community: Redis (BullMQ and pure-list variants), MySQL, MongoDB, NATS JetStream, Cloudflare DO, Turso/libSQL, Upstash, Azure, Platformatic, Jazz. Community worlds are single-org maintained — maturity risk.

For baka self-host: **Postgres World is exactly the target shape** (self-hosted Node server + Postgres, graphile-worker underneath). One workflow codebase, swap `WORKFLOW_TARGET_WORLD` between `@workflow/world-vercel` (hosted hub) and `@workflow/world-postgres` (self-host). Local dev uses the bundled local world for free.

Caveat: the self-hosted app must be served through a supported integration. For Hono the documented path is Nitro (`workflow/nitro` module + `nitro`/`rollup` build). A Hono-on-plain-Node (e.g. `@hono/node-server` with tsc/tsx) is not a documented setup — the directive transform still has to run, so adopting the SDK effectively means adopting Nitro (or another supported builder) for the registry server.

Sources:
- https://workflow-sdk.dev/worlds
- https://workflow-sdk.dev/worlds/postgres
- https://workflow-sdk.dev/worlds/local
- https://workflow-sdk.dev/worlds/vercel
- https://workflow-sdk.dev/docs/deploying
- https://www.npmjs.com/package/@workflow/world-postgres
- https://github.com/vercel/workflow/tree/main/packages/world-postgres

## 3. Execution model limits (child processes, fs, time)

- **Step functions have full Node.js runtime access** — `child_process`, `fs`, arbitrary npm packages are all allowed inside a step. Nothing in the SDK restricts spawning a `git clone` or a `node --permission` sandbox child process. On a self-hosted long-running server (Postgres world), there are **no platform time limits at all** — a 2–5 min step is fine.
- On Vercel (hosted hub):
  - Each step executes inside a Vercel Function invocation, so it inherits function limits: **300s default, 800s max (Pro/Enterprise GA), 1800s extended max (beta, per-function config)**. A 5-min ingest job fits within 800s but has little headroom; jobs at the upper end of the 30s–5min range should get `maxDuration: 800` (or split into more steps).
  - Function filesystem is **read-only except `/tmp`** (Lambda-style). Clone into `/tmp`, screen there, upload artifacts to object storage/DB, clean up.
  - `git` is **not preinstalled** in Vercel's Node runtime image; you would need to bundle a git binary (e.g. via a lambda layer / vendored binary, or use `isomorphic-git` in pure JS). `node --permission` requires Node >= 20/22 with the permission model — Vercel supports nodejs20.x/22.x/24.x, so spawning `process.execPath --permission ...` as a child is technically possible, but the sandbox's fs write needs would also be confined to `/tmp`, which the permission model can express.
  - Max function memory 2 GB (Hobby) / 4 GB (Pro/Ent). Bundle 250 MB uncompressed (5 GB beta).
- The **workflow (orchestrator) function** cannot do any of this — it is sandboxed, no Node APIs, deterministic-only. All clone/scan/fs work must live in steps. That is naturally how our pipeline would be structured anyway (one step per pipeline stage).
- Local world runs steps in-process on the dev server — child processes and fs work fine there too.

Sources:
- https://workflow-sdk.dev/docs/foundations/workflows-and-steps ("Step functions ... have full runtime access", "Full Node.js runtime and npm package access")
- https://vercel.com/docs/functions/limitations
- https://vercel.com/docs/functions/configuring-functions/duration
- https://vercel.com/docs/functions/runtimes

## 4. Retry / durability semantics

- **At-least-once per step.** Steps retry automatically (default 3 retries = 4 attempts; configurable via `maxRetries`, `FatalError` to bail, `RetryableError.retryAfter` for backoff). Docs explicitly warn: side effects in retried steps must be **idempotent** (they even ship an Idempotency foundations page).
- **Step-level memoization via event sourcing**: completed step results are written to the event log; on replay/resume the orchestrator re-runs but completed steps are served from the log, not re-executed.
- **Process crash mid-step**: the step attempt simply never records a result; the world (graphile-worker polling loop or Vercel Queues) re-delivers the job and the step **re-executes from the start of that step**, not from mid-step. So a crash 90s into a 2-min `git clone` step re-clones from scratch. Partial work inside a step is lost — keep steps atomic-ish (clone+validate as one step vs clone, then validate as separate steps is a real design decision: finer steps = better memoization but more serialization overhead).
- Workflow suspension uses **zero compute** while waiting (`sleep`, step execution, webhooks) — on Vercel this is the Fluid compute story; suspended workflows don't hold a function instance.
- Rollback/compensation is a manual pattern (record rollback steps per forward step), not built-in saga machinery.
- Postgres world "ensures workflows survive application restarts with all state reliably persisted". Local world does NOT (in-memory queue).

Sources:
- https://workflow-sdk.dev/docs/foundations/errors-and-retries
- https://workflow-sdk.dev/docs/foundations/workflows-and-steps (suspension/resumption)
- https://workflow-sdk.dev/worlds/postgres ("How It Works")
- https://workflow-sdk.dev/docs/how-it-works/event-sourcing (referenced)

## 5. Fit verdict

Workload recap: ingest jobs 30s–5min, git clone + AST scan + `node --permission` sandbox dry-run + preview artifacts + Postgres write; must run identically on hosted hub (could be Vercel) and on self-hosted org infra (plain Node, no Vercel account).

**Option (a) — Workflow SDK everywhere (Vercel world hosted, Postgres world self-hosted).**
Pros: one code path; official Postgres world is literally graphile-worker + Drizzle underneath, i.e. option (c)'s architecture with an orchestration layer on top; retries/suspension/observability (`npx workflow web` UI works against any world) for free; GA and very actively developed; the `workflow` dep is already in our package.json; local dev needs zero infra.
Cons: forces the registry server onto a supported builder (Hono → Nitro); the SDK's value (suspension, webhooks, sleeps, fan-out replay) is mostly wasted on a linear 5-stage batch pipeline; maturity risk is real for the Postgres world (first-party but young; the repo's own compat table only certifies it against Next.js/SvelteKit/Nitro e2e configs); Vercel world on 4.x pins data to `iad1`; debugging event-sourcing replay bugs is a new skill for the team.

**Option (b) — Workflow SDK hosted + plain in-process queue self-hosted.** Two code paths for the same pipeline. Violates single-path principle; the self-host path would get less testing. Reject.

**Option (c) — Skip the SDK; DB-backed job table + worker loop everywhere (Drizzle + polling / graphile-worker directly).**
Pros: simplest possible self-host story (one Postgres table, one worker loop, no build-time transform, no new runtime model); our pipeline is linear and coarse-grained, which a job table models perfectly; crash-mid-job semantics (re-run the job) are actually what we want — a 2-min clone+screen step is the unit of idempotency anyway, so step-level memoization buys little; zero new framework constraints on the Hono server; graphile-worker is the same engine the Postgres world uses, battle-tested since 2019.
Cons: we re-implement retries/backoff (graphile-worker has this built in), observability (a status column + admin query vs. a slick web UI), and the hosted side can't lean on Vercel Queues.

**Recommendation: (c), with graphile-worker as the job engine, and keep `workflow` out of the registry server.** Rationale:
1. The pipeline is a linear batch job, not a long-lived orchestration. The Workflow SDK's distinctive features (suspend/resume, sleeps, webhooks, deterministic replay) solve problems we don't have; its cost (mandatory SWC/Nitro build integration for the Hono server, a young self-host world, a new mental model) is paid for nothing.
2. The self-host story is the product. A Drizzle table + graphile-worker loop runs on any Node server with zero Vercel-shaped concepts, and the exact same code runs on the hosted hub (which is also just a Node server — nothing requires the hub to be serverless).
3. If we later want per-stage durability (resume a crashed ingest at the screening stage rather than re-cloning), we can model stages as chained jobs or revisit the Workflow SDK then — the job-table design doesn't foreclose that.
4. If the owner still wants to try the SDK: the only viable single-path version is (a) with `@workflow/world-postgres` self-hosted and the Vercel world hosted, which requires porting the registry server to Nitro first. That is a much bigger commitment than the job table.

## 6. Workflow SDK + Fluid compute / function time limits (Vercel)

- The SDK is designed around **Fluid compute**; docs repeatedly warn to enable it before deploying (without it, each workflow resume = a fresh cold start and higher cost). Fluid is enabled by default for new projects.
- A **workflow run has no duration limit** ("pause, resume, and maintain state for minutes to months without duration limits") because suspension consumes no compute — the run can span arbitrarily many invocations.
- But each **individual step still runs inside one function invocation**, so a step is bounded by the function's max duration: 300s default, **800s max on Pro/Enterprise (GA)**, 1800s (30 min) in beta for nodejs20.x/22.x/24.x with per-function config. Hobby is hard-capped at 300s. So a step cannot "exceed the 60s/300s function limit" — it just gets the raised Fluid limits; anything longer must be split into multiple steps.
- On self-hosted (Postgres world), steps run in the long-lived worker process with no platform-imposed time limit at all.

Sources:
- https://workflow-sdk.dev/docs/foundations/workflows-and-steps
- https://vercel.com/docs/fluid-compute
- https://vercel.com/docs/functions/configuring-functions/duration ("Extended max duration — Beta", up to 1800s; "For workloads that require unlimited execution time, use Vercel Workflows")
- https://vercel.com/docs/functions/limitations

## Appendix: all source URLs

- https://github.com/vercel/workflow
- https://workflow-sdk.dev/
- https://workflow-sdk.dev/worlds
- https://workflow-sdk.dev/worlds/vercel
- https://workflow-sdk.dev/worlds/postgres
- https://workflow-sdk.dev/worlds/local
- https://workflow-sdk.dev/docs/deploying
- https://workflow-sdk.dev/docs/foundations/workflows-and-steps
- https://workflow-sdk.dev/docs/foundations/errors-and-retries
- https://workflow-sdk.dev/docs/getting-started/hono
- https://vercel.com/blog/a-new-programming-model-for-durable-execution
- https://vercel.com/blog/introducing-workflow
- https://vercel.com/changelog/open-source-workflow-dev-kit-is-now-in-public-beta
- https://vercel.com/docs/workflows
- https://vercel.com/docs/fluid-compute
- https://vercel.com/docs/functions/limitations
- https://vercel.com/docs/functions/configuring-functions/duration
- https://www.npmjs.com/package/@workflow/world-postgres
- https://deepwiki.com/vercel/workflow/6.4-@workflowworld-postgres
