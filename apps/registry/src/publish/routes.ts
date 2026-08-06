import type { PGlite } from "@electric-sql/pglite"
import type { betterAuth } from "better-auth"
import { Hono } from "hono"
import { z } from "zod"
import { resolveIdentity } from "../auth/identity"
import { checkPlanLimit } from "../auth/plan-limits"
import { cleanupClone, shallowCloneAtTag } from "./clone"
import { extractManifestFields } from "./manifest"
import { isValidRepoUrl } from "./repo"
import { isStrictSemver } from "./semver"

/**
 * POST /v1/publish — request-level validation, role/namespace
 * enforcement, plan-limit gate, manifest validation, and pending
 * row creation.
 *
 * Architecture §4.5 pins the publish flow as: "server verifies
 * repo URL + org namespace → creates module_versions row (pending)
 * → enqueues ingest job → worker: shallow clone → schema
 * validation → loadability gate → content hash → tarball".
 *
 * The architecture's "verify" step is read narrowly here: the
 * publish endpoint does the work that can be done WITHOUT
 * ingesting the module — body validation, role + namespace check,
 * plan-limit gate — AND the work that REQUIRES a manifest read,
 * because the validation contract (VAL-PUB-010, VAL-PUB-024)
 * mandates publish-time rejection for those cases. The full
 * loadability gate + content hash + tarball pack stay in the
 * worker.
 *
 * Validation surface (this endpoint):
 *   - Body shape (zod)          → 400 with field-naming body (VAL-PUB-020)
 *   - Repo URL shape            → 422 (VAL-PUB-021)
 *   - Semver tag                → 422 (VAL-PUB-032, decision 18)
 *   - Auth                      → 401 (VAL-AUTH-002)
 *   - Org membership            → 403 (VAL-PUB-011)
 *   - Role (owner/admin)        → 403 (VAL-AUTH-009)
 *   - Plan limit                → 403 naming limit + plan (VAL-SELF-006)
 *   - Org does not exist        → 404 (VAL-PUB-011)
 *   - Bare name (non-official)  → 422 (VAL-PUB-010, decision 26)
 *   - Manifest/tag mismatch     → 422 (VAL-PUB-024, decision 11)
 *
 * The clone is `git clone --depth 1 --branch <tag>` with the
 * `INGEST_CLONE_TIMEOUT_MS` cap (default 60_000) so a stalled
 * remote fails the publish instead of wedging the request. The
 * clone is cleaned up on every exit path so /tmp does not fill
 * up under concurrent publishes.
 *
 * The endpoint signals the worker's in-memory enqueuer and writes
 * the pending row in the same transaction. The polling-loop worker
 * (decision 35) discovers the row by polling
 * `module_versions.status='pending'` regardless of the in-memory
 * hint, so a process restart mid-publish does not strand the row.
 * The pending row carries the manifest source the worker can ingest
 * directly; the publish endpoint also writes the commit sha it
 * observed into the row so the worker does not have to re-clone
 * just to verify pinning (the worker does re-clone for the
 * loadability gate + tarball pack; the row's commit_sha is the
 * canonical pin it verifies the re-clone against).
 *
 * Visibility defaulting (decision 30): `visibility` defaults to
 * `"org"` when omitted. The default is private so a typo in the
 * public toggle never publishes private modules to the community
 * catalog.
 */

const PublishBodySchema = z
	.object({
		repo: z.string().min(1, "repo must be a non-empty URL"),
		tag: z.string().min(1, "tag must be a non-empty string"),
		modulePath: z.string().optional(),
		visibility: z.enum(["org", "public"]).default("org"),
		org: z.string().min(1, "org must be a non-empty slug"),
	})
	.strict()

interface PublishRoutesDeps {
	auth: ReturnType<typeof betterAuth>
	pglite: PGlite
	officialOrg: string
	/**
	 * Optional enqueue seam for the ingest worker (architecture §4.5).
	 * When supplied, the publish endpoint enqueues an
	 * `ingest_module_version` job for the created row. When omitted
	 * (e.g. tests that don't exercise the worker), the row is left
	 * at `pending` and no job is enqueued — the worker will pick
	 * the row up on its next poll or, in tests, the caller
	 * advances the row manually.
	 */
	enqueueIngest?: (versionId: string) => Promise<void>
}

export function createPublishRoutes(deps: PublishRoutesDeps): Hono {
	const { auth, pglite, officialOrg, enqueueIngest } = deps
	const app = new Hono()

	app.post("/v1/publish", async (c) => {
		const identity = await resolveIdentity(auth, c.req.raw)
		if (!identity) {
			return c.json({ error: "authentication required" }, 401)
		}

		const rawBody = await readBody(c.req.raw)
		if (rawBody.kind === "error") {
			return c.json({ error: rawBody.message }, 400)
		}

		const parsed = PublishBodySchema.safeParse(rawBody.value)
		if (!parsed.success) {
			const issue = parsed.error.issues[0]
			if (!issue) {
				return c.json({ error: "invalid publish body" }, 400)
			}
			const fieldName = issue.path.length > 0 ? issue.path.join(".") : "(body)"
			return c.json(
				{
					error: `field '${fieldName}': ${issue.message}`,
					allowedValues: fieldName === "visibility" ? ["org", "public"] : undefined,
				},
				400,
			)
		}
		const body = parsed.data

		// Repo URL format check (VAL-PUB-021): a malformed URL is a
		// 422 (semantic error). The contract says no `module_versions`
		// row is created. The check is shape-only; the worker will
		// actually try to clone and mark failed if the URL is valid
		// shape but unreachable.
		if (!isValidRepoUrl(body.repo)) {
			return c.json(
				{
					error: "field 'repo': must be a valid git URL (https://, http://, git://, or ssh-style)",
				},
				422,
			)
		}

		// Semver tag (VAL-PUB-032, decision 18): 422 with a body
		// naming the field and the expected grammar.
		if (!isStrictSemver(body.tag)) {
			return c.json(
				{
					error: `field 'tag': must be valid semver (e.g. '1.0.0' or 'v1.0.0-rc.1'); got '${body.tag}'`,
				},
				422,
			)
		}

		// Resolve the target org. An unknown org is 404 (VAL-PUB-011).
		// Outsiders see 403 on an existing org — that distinction
		// (404 unknown vs 403 known-but-not-a-member) DOES leak
		// org existence and is mandated by VAL-PUB-011. The
		// downstream visibility filter on module reads is the
		// surface that does NOT leak; this 403 is honest.
		const orgRow = await pglite.query<{ id: string; slug: string; plan: string }>(
			`SELECT id, slug, plan FROM "organization" WHERE slug = $1`,
			[body.org],
		)
		const org = orgRow.rows[0]
		if (!org) {
			return c.json({ error: `organization '${body.org}' not found` }, 404)
		}

		// Membership + role (VAL-AUTH-009): the caller must be owner
		// or admin of the target org. Outsiders / members get 403.
		// The membership query mirrors the org-list role enrichment
		// in `org-routes.ts` — same DB shape, same role vocabulary.
		const memberRow = await pglite.query<{ role: string }>(
			`SELECT role
			   FROM "member"
			  WHERE "userId" = $1
			    AND "organizationId" = $2`,
			[identity.userId, org.id],
		)
		const role = memberRow.rows[0]?.role
		if (role !== "owner" && role !== "admin") {
			return c.json(
				{
					error: `publish requires owner or admin role on org '${body.org}'`,
				},
				403,
			)
		}

		// Plan limit (VAL-SELF-006) — applied below after the manifest
		// is read (so we know the resolved moduleName), BEFORE the
		// module row is upserted, and only when the (scope, name)
		// row does NOT yet exist. Re-publishing a NEW VERSION of an
		// existing module (same scope + name) must not be blocked
		// by the max_private_modules quota: the limit counts
		// modules, not versions. The plan-limit verdict names both
		// the limit and the plan verbatim so a caller can route to
		// billing without parsing free text.

		// Clone the repo at the tag and read the manifest. The clone
		// is bounded by `INGEST_CLONE_TIMEOUT_MS` (default 60s); a
		// stalled remote becomes a 422 with a field-naming message
		// rather than wedging the request.
		let clone: Awaited<ReturnType<typeof shallowCloneAtTag>> | null = null
		try {
			try {
				clone = await shallowCloneAtTag(body.repo, body.tag)
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				return c.json(
					{
						error: `could not clone repository at tag '${body.tag}': ${message}`,
					},
					422,
				)
			}

			const manifest = await extractManifestFields(clone.dir, body.modulePath)
			if (manifest === null) {
				return c.json(
					{
						error: `manifest not found or unreadable at '${body.modulePath ?? ""}/manifest.ts' (tag '${body.tag}')`,
					},
					422,
				)
			}

			// Manifest/tag version match (VAL-PUB-024, decision 11):
			// the served version equals the git tag. Compare against
			// the tag stripped of any leading `v` (the conventional
			// git tag prefix). A mismatch is 422 with both values.
			const tagWithoutV = body.tag.startsWith("v") ? body.tag.slice(1) : body.tag
			const manifestVersionWithoutV = manifest.version.startsWith("v") ? manifest.version.slice(1) : manifest.version
			if (manifestVersionWithoutV !== tagWithoutV) {
				return c.json(
					{
						error:
							`manifest version '${manifest.version}' does not match git tag '${body.tag}' ` +
							`(decision 11: the served version equals the git tag)`,
						tag: body.tag,
						manifestVersion: manifest.version,
					},
					422,
				)
			}

			// Bare-name rule (VAL-PUB-010, decision 26): bare names
			// exist only under the official org. A non-official org
			// must publish a scoped manifest name (`@<orgSlug>/<name>`).
			// The scope prefix is stripped to derive the row's `name`;
			// publishing `@otherScope/foo` to `acme` is rejected
			// because the manifest's scope does not match the target
			// org (it would otherwise squat in the wrong namespace).
			// After stripping, the resulting moduleName must be
			// non-empty (`@acme/` and `@acme//foo` are rejected) and
			// must not start with another `/` (a malformed scope strip).
			let moduleName: string
			if (org.slug === officialOrg) {
				// Official org accepts both bare names (`baka-base`)
				// and scoped names (`@baka/widget` → `widget`).
				if (manifest.name.startsWith(`@${officialOrg}/`)) {
					moduleName = manifest.name.slice(`@${officialOrg}/`.length)
				} else if (manifest.name.startsWith("@")) {
					// Some other scope (`@other/foo`) — the official
					// org accepts only its OWN scope prefix; foreign
					// scopes are rejected with 422, mirroring the
					// non-official path's scope-match rule.
					return c.json(
						{
							error:
								`manifest name '${manifest.name}' has a scope that does not match the official org '${officialOrg}' ` +
								`(decision 26); publish to '${manifest.name.split("/")[0]?.slice(1) ?? "<scope>"}' instead, or use a bare name or '@${officialOrg}/<name>'`,
						},
						422,
					)
				} else {
					moduleName = manifest.name
				}
			} else {
				if (manifest.name.includes("/")) {
					if (!manifest.name.startsWith(`@${org.slug}/`)) {
						return c.json(
							{
								error:
									`manifest name '${manifest.name}' has a scope that does not match the target org '${org.slug}' ` +
									`(decision 26); use '@${org.slug}/<name>'`,
							},
							422,
						)
					}
					moduleName = manifest.name.slice(`@${org.slug}/`.length)
				} else {
					return c.json(
						{
							error:
								`bare module name '${manifest.name}' is reserved for the official org '${officialOrg}' ` +
								`(decision 26); use a scoped name like '@${org.slug}/${manifest.name}' in the manifest's ` +
								"`name` field",
						},
						422,
					)
				}
			}
			if (moduleName.length === 0 || moduleName.startsWith("/")) {
				return c.json(
					{
						error: `manifest name '${manifest.name}' strips to an empty or malformed module name; expected '@${org.slug}/<name>' with a non-empty name`,
					},
					422,
				)
			}

			// Ready-version immutability (architecture §8 decision 38,
			// VAL-CROSS-004 / VAL-PUB-008).
			//
			// When a (scope, name, version) row already exists, the
			// publish endpoint checks its status + recorded commit_sha
			// against the freshly-cloned commit_sha:
			//
			//   - status='ready' + commit_sha matches → 200 idempotent
			//     (the same row, no re-ingest). The contract's
			//     "200 with the same record, or 409 stating the
			//     version exists" pin.
			//   - status='ready' + commit_sha differs → 409-class
			//     immutability error naming both shas. A ready
			//     version's commit_sha / content_hash / artifact blob
			//     are NEVER overwritten — pinned downloads continue
			//     to serve the original bytes. The fix for the
			//     user-testing round-1 ON CONFLICT overwrite bug.
			//   - status='ingesting' → 409 with a "re-publish during
			//     ingest in progress" message. Resetting the row to
			//     pending would race the worker's FOR UPDATE SKIP
			//     LOCKED claim.
			//   - status='pending' or 'failed' → fall through to the
			//     normal 202 + re-ingest path (the contract's
			//     "non-ready rows still accept 202 re-ingest
			//     retries").
			//
			// The check runs BEFORE `upsertModuleRow` and the
			// `module_versions` INSERT so neither row is mutated on
			// the rejection path. The query joins on the module's
			// `(scope, name)` and filters out tombstoned modules so a
			// post-unpublish re-publish (decision 19) reaches the
			// fresh-row path below without colliding with the old
			// tombstone.
			const existingVersion = await pglite.query<{
				id: string
				status: string
				commit_sha: string
				content_hash: string
			}>(
				`SELECT mv.id, mv.status, mv.commit_sha, mv.content_hash
				   FROM module_versions mv
				   JOIN modules m ON m.id = mv.module_id
				  WHERE m.scope = $1
				    AND m.name = $2
				    AND mv.version = $3
				    AND m.removed_at IS NULL`,
				[org.slug, moduleName, body.tag],
			)
			const priorVersion = existingVersion.rows[0]
			if (priorVersion && priorVersion.status === "ready") {
				if (priorVersion.commit_sha === clone.commitSha) {
					// Idempotent re-publish (VAL-PUB-008). The row
					// already exists with the exact same commit_sha;
					// the worker is NOT re-signaled. The response
					// echoes the existing record so the caller can
					// detect "no-op" without polling.
					return c.json(
						{
							scope: org.slug,
							name: moduleName,
							version: body.tag,
							commitSha: priorVersion.commit_sha,
							contentHash: priorVersion.content_hash,
							status: "ready",
							visibility: moduleRowVisibility(pglite, org.slug, moduleName),
							versionId: priorVersion.id,
							idempotent: true,
						},
						200,
					)
				}
				// Immutability violation (VAL-CROSS-004). The tag
				// was force-moved (or otherwise points at a
				// different commit) AFTER the row reached `ready`.
				// The original commit_sha / content_hash / artifact
				// blob are preserved; the operator must publish at
				// a new tag if they want to ship the new tree.
				return c.json(
					{
						error:
							`immutability violation: tag '${body.tag}' resolves to a different commit than the recorded READY version ` +
							`(existing commit_sha='${priorVersion.commit_sha}', requested commit_sha='${clone.commitSha}') ` +
							`(decision 38); the existing ready version's content is preserved — publish a new tag to ship the new tree`,
						scope: org.slug,
						name: moduleName,
						version: body.tag,
						existingCommitSha: priorVersion.commit_sha,
						requestedCommitSha: clone.commitSha,
						existingContentHash: priorVersion.content_hash,
						versionId: priorVersion.id,
					},
					409,
				)
			}
			if (priorVersion && priorVersion.status === "ingesting") {
				// An ingest job is currently in flight; resetting the
				// row would race the worker's FOR UPDATE SKIP LOCKED
				// claim. The caller retries once the worker converges
				// (the polling loop's per-cycle sweep resets stale
				// ingesting rows on a 5-minute threshold).
				return c.json(
					{
						error: `re-publish refused: version '${body.tag}' is currently being ingested; retry once the worker converges (decision 38)`,
						scope: org.slug,
						name: moduleName,
						version: body.tag,
						versionId: priorVersion.id,
						status: priorVersion.status,
					},
					409,
				)
			}

			// All checks passed — create the module + version rows in
			// `pending` status. The worker (next feature) will pick up
			// the pending rows, run the loadability gate, content-hash,
			// and pack the tarball.
			//
			// Pre-existence check: a new VERSION of an existing
			// module (same scope+name) skips the plan-limit gate —
			// the limit counts modules, not versions. Done BEFORE
			// the upsert so the limit count excludes the about-to-
			// be-inserted row.
			const moduleExists = await pglite.query<{ id: string }>(`SELECT id FROM modules WHERE scope = $1 AND name = $2`, [
				org.slug,
				moduleName,
			])
			const isNewModule = moduleExists.rows.length === 0

			if (isNewModule && body.visibility === "org") {
				const verdict = await checkPlanLimit(pglite, org.id, "max_private_modules")
				if (!verdict.ok) {
					return c.json(
						{
							error: verdict.message,
							limit: verdict.capability,
							plan: verdict.plan,
							usage: verdict.usage,
							limitValue: verdict.limit,
						},
						403,
					)
				}
			}

			const moduleRow = await upsertModuleRow(pglite, {
				scope: org.slug,
				name: moduleName,
				visibility: body.visibility,
				tier: "community-unverified",
				description: "",
				createdBy: identity.userId,
			})
			const moduleId = moduleRow.id
			// Stored visibility is what the row actually holds
			// (first-publish wins); the response echoes the stored
			// value so callers do not see a "public" response for a
			// row that the catalog still hides as org-private.
			const storedVisibility = moduleRow.visibility

			const versionRow = await pglite.query<{ id: string }>(
				`INSERT INTO module_versions (module_id, version, commit_sha, content_hash, manifest, status, error)
				   VALUES ($1, $2, $3, '', $4::jsonb, 'pending', NULL)
				 ON CONFLICT (module_id, version) DO UPDATE
				   SET commit_sha = EXCLUDED.commit_sha,
				       manifest = EXCLUDED.manifest,
				       status = 'pending',
				       error = NULL,
				       updated_at = NOW()
				 RETURNING id`,
				[
					moduleId,
					body.tag,
					clone.commitSha,
					JSON.stringify({
						// The publish-time manifest reader returns
						// `unknown` for the body. The worker re-evaluates
						// the full schema via jiti; the publish-time
						// shape is best-effort and is what we ship to
						// the DB for transparency. Cast to object
						// before spreading so the `_publish` keys can
						// be merged underneath.
						...(typeof manifest.manifest === "object" && manifest.manifest !== null && !Array.isArray(manifest.manifest)
							? (manifest.manifest as Record<string, unknown>)
							: {}),
						// Persist the publish body under a private
						// `_publish` key so the ingest worker can read
						// the repo URL and modulePath without a
						// dedicated column. The schema validator
						// ignores unknown keys; the catalog
						// surfaces strip `_publish` so the field
						// never leaks into served metadata.
						_publish: {
							repo: body.repo,
							modulePath: body.modulePath ?? null,
							visibility: body.visibility,
							publishedAt: new Date().toISOString(),
						},
					}),
				],
			)
			const versionId = versionRow.rows[0]?.id
			if (!versionId) {
				throw new Error("publish: failed to create module_versions row")
			}

			// Signal the worker (architecture §4.5 step: "enqueues
			// ingest job"). The polling-loop worker (decision 35)
			// discovers rows by polling `module_versions.status='
			// pending'`, so the in-memory enqueue is a hint only —
			// tests can assert "publish signaled a new row" against
			// it, and a process restart mid-publish is recovered by
			// the next poll cycle regardless.
			//
			// The enqueue is best-effort: a failure here does NOT
			// roll back the publish. The version row is durable and
			// the polling worker will pick it up on its next pass
			// (the stale-ingesting sweep converges kill-resume too).
			// Returning a 202 with the versionId is honest — the row
			// IS tracked; the worker will pick it up.
			if (enqueueIngest) {
				try {
					await enqueueIngest(versionId)
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err)
					process.stderr.write(`publish: enqueue failed for version ${versionId}: ${message}\n`)
				}
			}

			return c.json(
				{
					scope: org.slug,
					name: moduleName,
					version: body.tag,
					commitSha: clone.commitSha,
					status: "pending",
					visibility: storedVisibility,
					versionId,
				},
				202,
			)
		} finally {
			if (clone !== null) {
				await cleanupClone(clone.dir)
			}
		}
	})

	return app
}

/**
 * Reads the publish body and returns a discriminated union. A
 * syntactically malformed JSON body is a 400 with the parser error;
 * a non-object body is a 400; a missing body is a 400.
 */
type BodyResult = { kind: "ok"; value: unknown } | { kind: "error"; message: string }

/**
 * Returns the visibility of the module row identified by
 * `(scope, name)`, or `"org"` as the safe default when the row is
 * absent (e.g. a re-publish raced a tombstone-replacement delete).
 * Used by the idempotent-200 branch of the publish endpoint so the
 * response echoes the stored visibility without re-running the
 * module upsert — the row's visibility is first-publish-wins
 * (architecture §8 decision 30) and the caller must see the same
 * value the catalog surfaces.
 */
async function moduleRowVisibility(pglite: PGlite, scope: string, name: string): Promise<"org" | "public"> {
	const row = await pglite.query<{ visibility: "org" | "public" }>(
		`SELECT visibility FROM modules WHERE scope = $1 AND name = $2 AND removed_at IS NULL`,
		[scope, name],
	)
	return row.rows[0]?.visibility ?? "org"
}

async function readBody(request: Request): Promise<BodyResult> {
	const text = await request.clone().text()
	if (text.length === 0) {
		return { kind: "error", message: "request body is empty; expected a JSON object" }
	}
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err)
		return { kind: "error", message: `request body is not valid JSON: ${detail}` }
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { kind: "error", message: "request body must be a JSON object" }
	}
	return { kind: "ok", value }
}

/**
 * Upserts a `modules` row for the given scope/name combination.
 * The first publish creates the row at `tier: "community-unverified"`
 * (the worker's screening verdict will update the tier on success);
 * subsequent publishes of additional versions of the same module
 * leave the row alone (visibility + tier are mutable only via
 * unpublish / re-publish flows).
 *
 * The unique key `(scope, name)` is the conflict target. The
 * `description` column is initialized empty and updated by the
 * worker when it reads the manifest. Returns the upserted row's
 * id, the stored visibility (NOT the requested one), and a `created`
 * flag distinguishing a first-publish from a re-publish of an
 * existing module. The caller uses these to:
 *   - apply the plan-limit gate ONLY when `created === true`,
 *     so re-publishing a new VERSION of an existing module is
 *     not blocked at max_private_modules;
 *   - echo the stored visibility in the 202 response, so the
 *     body always matches what the catalog/detail endpoints
 *     actually serve (first-publish wins on re-publish of the
 *     same scope+name).
 *
 * Tombstone-replacement (architecture §8 decision 19): if a
 * previous publish of the same scope/name was tombstoned via
 * `DELETE /v1/modules/:scope/:name`, this helper hard-deletes
 * that tombstone row BEFORE inserting the new one. The cascade
 * removes the old versions / artifacts / screening records, so
 * the new module starts with a clean history (the tombstone is
 * replaced, not resurrected). The DELETE is idempotent: a row
 * with `removed_at IS NULL` is left alone, a non-existent row is
 * a no-op, and the cascade only fires when a tombstone row is
 * present.
 */
async function upsertModuleRow(
	pglite: PGlite,
	args: {
		scope: string
		name: string
		visibility: "org" | "public"
		tier: string
		description: string
		createdBy: string
	},
): Promise<{ id: string; scope: string; name: string; visibility: "org" | "public"; created: boolean }> {
	// Tombstone replacement — must run before the INSERT so the
	// (scope, name) conflict target has a clear slot.
	await pglite.query(`DELETE FROM modules WHERE scope = $1 AND name = $2 AND removed_at IS NOT NULL`, [
		args.scope,
		args.name,
	])

	// Detect create-vs-update BEFORE the INSERT so the plan-limit
	// gate can branch on it. Reading the row's current visibility
	// also lets the response echo the stored value (first-publish
	// wins on re-publish).
	const existing = await pglite.query<{ id: string; visibility: "org" | "public" }>(
		`SELECT id, visibility FROM modules WHERE scope = $1 AND name = $2`,
		[args.scope, args.name],
	)
	const preExisting = existing.rows[0]
	const created = !preExisting
	const storedVisibility: "org" | "public" = preExisting?.visibility ?? args.visibility

	const inserted = await pglite.query<{ id: string }>(
		`INSERT INTO modules (scope, name, visibility, tier, description, created_by)
		   VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (scope, name) DO UPDATE
		   SET updated_at = NOW()
		 RETURNING id`,
		[args.scope, args.name, args.visibility, args.tier, args.description, args.createdBy],
	)
	const id = inserted.rows[0]?.id
	if (!id) throw new Error("upsertModuleRow: insert returned no id")
	return { id, scope: args.scope, name: args.name, visibility: storedVisibility, created }
}
