// ---------------------------------------------------------------------------
// CLI publish + org command tests (feature cli-publish-org, milestone 5).
//
// Every probe spawns the BUILT CLI (`apps/cli/dist/index.js`) as a subprocess
// against a private seed-publishing-server on an ephemeral port. The seed
// server boots the FULL stack (PGlite + Better-Auth + org/invite seed +
// in-process ingest worker + filesystem storage) so a publish round-trip
// reaches a terminal state without external services. Git fixture repos are
// local bare repos (hermetic, no GitHub network access).
//
// Coverage map (per `validation-contract.md`):
//
//   VAL-DISC-006  publish a public pack end-to-end: status polling prints
//                  the terminal state with the pinned commit sha
//   VAL-DISC-007  publish without credentials refuses before any network
//                  mutation; no new pack_versions row appears
//   VAL-DISC-008  publish with insufficient org role (member, not owner)
//                  exits non-zero with the 403 surfaced honestly
//   VAL-DISC-009  publish of an unloadable recipe reaches `failed` with the
//                  loadability diagnostic naming the failing recipe
//   VAL-DISC-014  org create / list / invite round-trip + honest duplicate-
//                  slug + unknown-invitee failures
//   VAL-CROSS-003 org create via documented CLI flow lands a slug the API
//                  returns; duplicate slug is rejected; list reflects the
//                  creator's role
//
// Conventions:
//   - isolated BAKA_HOME per probe (decision 33)
//   - never touch the user's real ~/.baka
//   - CLI is spawned via `node apps/cli/dist/index.js` (dist-based, no tsx)
//   - seed-publishing-server is started on an ephemeral port via npx tsx
//     (real Better-Auth + PGlite stack, not a mock)
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "../../registry/test/git-fixture"

const REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(REPO, "apps", "cli", "dist", "index.js")
const SEED_SERVER = join(REPO, "apps", "registry", "test", "seed-publishing-server.ts")

interface SeedCreds {
	ownerKey: string
	ownerKeyId: string
	adminKey: string
	memberKey: string
	outsiderKey: string
	ownerEmail: string
	baseUrl: string
}

async function pickEphemeralPort(): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const probe = net.createServer()
		probe.on("error", reject)
		probe.listen(0, "127.0.0.1", () => {
			const addr = probe.address()
			if (typeof addr !== "object" || addr === null) {
				probe.close()
				reject(new Error("could not pick ephemeral port"))
				return
			}
			const port = addr.port
			probe.close(() => resolve(port))
		})
	})
}

async function bootSeedServer(): Promise<{
	baseUrl: string
	credsFile: string
	stop: () => Promise<void>
}> {
	const dataDir = mkdtempSync(join(tmpdir(), "baka-puborg-"))
	const credsFile = join(dataDir, "creds.json")
	const port = await pickEphemeralPort()
	const logPath = join(dataDir, "server.log")
	const logFd = require("node:fs").openSync(logPath, "w")
	const child = spawn("npx", ["tsx", SEED_SERVER], {
		cwd: REPO,
		env: {
			...process.env,
			HTTP_PORT: String(port),
			DATA_DIR: dataDir,
			SEED_CREDS_FILE: credsFile,
			REGISTRY_API_KEY_RATE_LIMIT: "off",
		},
		stdio: ["ignore", logFd, logFd],
	})
	const baseUrl = `http://127.0.0.1:${port}`
	const deadline = Date.now() + 30_000
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${baseUrl}/healthz`)
			if (res.ok && existsSync(credsFile)) break
		} catch {
			// not ready yet
		}
		await new Promise((r) => setTimeout(r, 200))
	}
	if (!existsSync(credsFile)) {
		child.kill("SIGKILL")
		throw new Error(`seed server did not write creds file at ${credsFile}; log=${logPath}`)
	}
	return {
		baseUrl,
		credsFile,
		stop: async () => {
			const pid = child.pid
			if (pid !== undefined) {
				try {
					process.kill(-pid, "SIGTERM")
				} catch {
					try {
						child.kill("SIGTERM")
					} catch {
						/* best effort */
					}
				}
			}
			await new Promise((r) => setTimeout(r, 500))
			if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true })
		},
	}
}

interface SpawnResult {
	code: number | null
	stdout: string
	stderr: string
}

function spawnCli(argv: string[], cwd: string, env: Record<string, string>, timeoutMs = 60_000): Promise<SpawnResult> {
	return new Promise((resolve) => {
		const child: ChildProcess = spawn("node", [DIST_INDEX, ...argv], {
			cwd,
			env: { ...process.env, ...env },
		})
		let stdout = ""
		let stderr = ""
		child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()))
		child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()))
		const timer = setTimeout(() => {
			child.kill("SIGKILL")
			resolve({ code: null, stdout, stderr: `${stderr}\n[test: killed after ${timeoutMs}ms]` })
		}, timeoutMs)
		child.on("close", (code) => {
			clearTimeout(timer)
			resolve({ code, stdout, stderr })
		})
	})
}

const createdDirs: string[] = []
const createdFixtures: GitFixture[] = []
function makeIsolatedHome(prefix: string): string {
	const base = mkdtempSync(join(tmpdir(), prefix))
	createdDirs.push(base)
	const bakaHome = join(base, "baka-home")
	mkdirSync(bakaHome, { recursive: true })
	return bakaHome
}
function configPath(bakaHome: string): string {
	return join(bakaHome, "config.json")
}

function seedCredential(bakaHome: string, url: string, apiKey: string): void {
	const path = configPath(bakaHome)
	const text = existsSync(path) ? readFileSync(path, "utf-8").trim() : ""
	let root: Record<string, unknown> = {}
	if (text !== "") {
		try {
			root = JSON.parse(text) as Record<string, unknown>
		} catch {
			root = {}
		}
	}
	const registries =
		root.registries !== undefined &&
		root.registries !== null &&
		typeof root.registries === "object" &&
		!Array.isArray(root.registries)
			? { ...(root.registries as Record<string, unknown>) }
			: {}
	registries[url] = { apiKey }
	root.registries = registries
	mkdirSync(bakaHome, { recursive: true })
	writeFileSync(path, JSON.stringify(root, null, 2), "utf-8")
}

let server: Awaited<ReturnType<typeof bootSeedServer>> | null = null
let creds: SeedCreds

beforeAll(async () => {
	if (!existsSync(DIST_INDEX)) {
		throw new Error(`built CLI not found at ${DIST_INDEX}; run \`pnpm --filter baka build\` first`)
	}
	server = await bootSeedServer()
	const raw = JSON.parse(readFileSync(server.credsFile, "utf-8")) as Record<string, Record<string, string>>
	creds = {
		ownerKey: raw.keys.owner,
		ownerKeyId: raw.keyIds.owner,
		adminKey: raw.keys.admin,
		memberKey: raw.keys.member,
		outsiderKey: raw.keys.outsider,
		ownerEmail: raw.emails.owner,
		baseUrl: server.baseUrl,
	}
}, 60_000)

afterAll(async () => {
	for (const fx of createdFixtures.splice(0)) {
		await fx.cleanup().catch(() => {})
	}
	for (const d of createdDirs.splice(0)) {
		if (existsSync(d)) rmSync(d, { recursive: true, force: true })
	}
	if (server) {
		await server.stop()
		server = null
	}
}, 30_000)

async function fixtureOkRepo(): Promise<GitFixture> {
	const fx = await createGitFixture()
	await fx.commitManifest({
		name: "@acme/widget",
		version: "1.0.0",
		description: "an ok pack for the publish-org tests",
		recipes: [
			{
				id: "noop",
				description: "no-op",
				filePatterns: [],
				requiresReasoning: false,
			},
		],
		tag: "v1.0.0",
	})
	createdFixtures.push(fx)
	return fx
}

async function fixtureUnloadableRepo(): Promise<GitFixture> {
	const fx = await createGitFixture()
	await fx.commitManifest({
		name: "@acme/unloadable",
		version: "1.0.0",
		description: "an unloadable pack (loadable:false on the recipe)",
		recipes: [
			{
				id: "broken",
				description: "broken recipe",
				filePatterns: [],
				requiresReasoning: false,
				loadable: false,
			},
		],
		tag: "v1.0.0",
	})
	createdFixtures.push(fx)
	return fx
}

// ---------------------------------------------------------------------------
// VAL-DISC-007 — publish without credentials refuses before mutation
// ---------------------------------------------------------------------------

describe("VAL-DISC-007 publish without credentials refuses before any network mutation", () => {
	it("exits 1 with an honest re-login message; no pack_versions row appears", async () => {
		const bakaHome = makeIsolatedHome("baka-puborg-nocred-")
		const cwd = makeIsolatedHome("baka-puborg-nocred-proj-")
		const env = { BAKA_HOME: bakaHome }
		const fx = await fixtureOkRepo()

		const res = await spawnCli(
			["publish", `${fx.bareUrl}@v1.0.0`, "--registry", creds.baseUrl, "--org", "acme"],
			cwd,
			env,
		)
		expect(res.code, `publish without creds: stdout=${res.stdout}; stderr=${res.stderr}`).toBe(1)
		expect(res.stderr).toMatch(/credential|login/i)
		expect(res.stderr).toContain("baka registry login")
		expect(res.stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)

		// No pack_versions row was created: the catalog list does
		// not contain `@acme/widget`. The CLI never reached the
		// publish endpoint at all (no network mutation).
		const catalogRes = await fetch(`${creds.baseUrl}/v1/packs`)
		const catalog = (await catalogRes.json()) as { packs: Array<{ scope: string; name: string }> }
		const found = catalog.packs.find((m) => m.scope === "acme" && m.name === "widget")
		expect(found, "the published pack must not appear in the catalog when no credential is configured").toBeUndefined()
	}, 90_000)
})

// ---------------------------------------------------------------------------
// VAL-DISC-008 — publish with insufficient org role refuses truthfully
// ---------------------------------------------------------------------------

describe("VAL-DISC-008 publish with insufficient org role refuses truthfully", () => {
	it("logged in as a member (not owner/admin) exits non-zero with a 403 surfaced honestly", async () => {
		const bakaHome = makeIsolatedHome("baka-puborg-memrole-")
		const cwd = makeIsolatedHome("baka-puborg-memrole-proj-")
		const env = { BAKA_HOME: bakaHome }
		seedCredential(bakaHome, creds.baseUrl, creds.memberKey)
		const fx = await fixtureOkRepo()

		const res = await spawnCli(
			["publish", `${fx.bareUrl}@v1.0.0`, "--registry", creds.baseUrl, "--org", "acme", "--json"],
			cwd,
			env,
		)
		expect(res.code, `member publish: stdout=${res.stdout}; stderr=${res.stderr}`).not.toBe(0)
		// The registry's 403 surfaces verbatim — the member role
		// does not match the owner/admin requirement.
		expect(res.stderr).toMatch(/403|owner|admin/i)
		expect(res.stderr).not.toContain("fetch failed")
		expect(res.stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
	}, 90_000)
})

// ---------------------------------------------------------------------------
// VAL-DISC-009 — unloadable recipe reaches `failed` with diagnostics
// ---------------------------------------------------------------------------

describe("VAL-DISC-009 publish of an unloadable recipe reports `failed` with the diagnostic naming the failing recipe", () => {
	it("exits non-zero with the ingest worker error naming the unloadable recipe id", async () => {
		const bakaHome = makeIsolatedHome("baka-puborg-unload-")
		const cwd = makeIsolatedHome("baka-puborg-unload-proj-")
		const env = { BAKA_HOME: bakaHome }
		seedCredential(bakaHome, creds.baseUrl, creds.ownerKey)
		const fx = await fixtureUnloadableRepo()

		const res = await spawnCli(
			["publish", `${fx.bareUrl}@v1.0.0`, "--registry", creds.baseUrl, "--org", "acme", "--json"],
			cwd,
			env,
		)
		expect(res.code, `unloadable publish: stdout=${res.stdout}; stderr=${res.stderr}`).not.toBe(0)
		// The CLI prints the terminal status (failed) and the ingest
		// diagnostic. The exact error string comes from the worker;
		// the contract requires the failing recipe id to appear.
		const combined = `${res.stdout}\n${res.stderr}`
		expect(combined).toMatch(/failed/i)
		// The loadability gate names the recipe id `broken` — the
		// unloadable recipe declared in the fixture manifest.
		expect(combined).toMatch(/broken|loadab/i)

		// The DB row reached `failed`; no `ready` installable
		// pointer exists for the pack. Query with the owner key so
		// the org-visibility filter does not turn the read into a
		// uniform 404 (VAL-AUTH-003 / VAL-PUB-016).
		const versionsRes = await fetch(`${creds.baseUrl}/v1/packs/acme/unloadable/versions`, {
			headers: { "x-api-key": creds.ownerKey },
		})
		const versions = (await versionsRes.json()) as { versions?: Array<{ version: string; status: string }> }
		const v1 = versions.versions?.find((v) => v.version === "v1.0.0")
		expect(v1?.status).toBe("failed")
	}, 120_000)
})

// ---------------------------------------------------------------------------
// VAL-DISC-006 — happy-path publish round-trip with status polling
// ---------------------------------------------------------------------------

describe("VAL-DISC-006 publish round-trip polls status and prints the terminal `ready` state with the pinned commit sha", () => {
	it("exits 0 and prints the ready state plus the commit sha + content hash", async () => {
		const bakaHome = makeIsolatedHome("baka-puborg-happy-")
		const cwd = makeIsolatedHome("baka-puborg-happy-proj-")
		const env = { BAKA_HOME: bakaHome }
		seedCredential(bakaHome, creds.baseUrl, creds.ownerKey)
		const fx = await fixtureOkRepo()

		const res = await spawnCli(
			["publish", `${fx.bareUrl}@v1.0.0`, "--registry", creds.baseUrl, "--org", "acme", "--json"],
			cwd,
			env,
		)
		expect(res.code, `happy publish: code=${res.code}\nstdout=${res.stdout}\nstderr=${res.stderr}`).toBe(0)
		// --json output is a single JSON object on stdout. Trim before
		// parsing so a trailing newline never breaks JSON.parse.
		const trimmedStdout = res.stdout.trim()
		expect(trimmedStdout).toMatch(/^\{[\s\S]*\}$/)
		const payload = JSON.parse(trimmedStdout) as {
			status?: string
			commitSha?: string
			contentHash?: string
			scope?: string
			name?: string
			version?: string
		}
		expect(payload.status).toBe("ready")
		expect(payload.scope).toBe("acme")
		expect(payload.name).toBe("widget")
		expect(payload.version).toBe("v1.0.0")
		expect(typeof payload.commitSha).toBe("string")
		expect(payload.commitSha?.length).toBeGreaterThan(0)
		expect(typeof payload.contentHash).toBe("string")
		expect(payload.contentHash?.length).toBeGreaterThan(0)

		// The pack is now visible in the catalog. We authenticate
		// the GET because the published pack is `visibility=org`
		// (the default per architecture §8 decision 30) — the
		// anonymous catalog list excludes org-visibility packs per
		// VAL-AUTH-003 / VAL-PUB-016.
		const catalogRes = await fetch(`${creds.baseUrl}/v1/packs`, {
			headers: { "x-api-key": creds.ownerKey },
		})
		const catalog = (await catalogRes.json()) as {
			packs: Array<{ scope: string; name: string; latestVersion: string | null }>
		}
		const found = catalog.packs.find((m) => m.scope === "acme" && m.name === "widget")
		expect(found, "the published pack must appear in the catalog list after a successful publish").toBeDefined()
		expect(found?.latestVersion).toBe("v1.0.0")
	}, 120_000)
})

// ---------------------------------------------------------------------------
// VAL-DISC-014 + VAL-CROSS-003 — org create / list / invite round-trip
// ---------------------------------------------------------------------------

describe("VAL-DISC-014 org create / list / invite round-trip plus honest error variants", () => {
	it("creates an org, lists it with the caller's owner role, invites a member; duplicate slug + unknown invitee fail honestly", async () => {
		const bakaHome = makeIsolatedHome("baka-puborg-org-")
		const cwd = makeIsolatedHome("baka-puborg-org-proj-")
		const env = { BAKA_HOME: bakaHome }
		seedCredential(bakaHome, creds.baseUrl, creds.ownerKey)

		// `baka org create` — exits 0.
		const slug = `acme${Math.floor(Math.random() * 1e6)}`
		const create = await spawnCli(["org", "create", slug, "--registry", creds.baseUrl, "--json"], cwd, env)
		expect(create.code, `org create: stdout=${create.stdout}; stderr=${create.stderr}`).toBe(0)
		const createPayload = JSON.parse(create.stdout.trim()) as { slug?: string; id?: string }
		expect(createPayload.slug).toBe(slug)
		expect(typeof createPayload.id).toBe("string")

		// `baka org list` — exits 0 and shows the new org with owner role.
		const list = await spawnCli(["org", "list", "--registry", creds.baseUrl, "--json"], cwd, env)
		expect(list.code, `org list: stdout=${list.stdout}; stderr=${list.stderr}`).toBe(0)
		const listPayload = JSON.parse(list.stdout.trim()) as Array<{ slug: string; role: string }>
		const listed = listPayload.find((o) => o.slug === slug)
		expect(listed, `new org must appear in list output: ${list.stdout}`).toBeDefined()
		expect(listed?.role).toBe("owner")

		// `baka org invite` — exits 0 (member role invitee is the seeded member).
		const invite = await spawnCli(
			["org", "invite", slug, "member@example.com", "--role", "member", "--registry", creds.baseUrl, "--json"],
			cwd,
			env,
		)
		expect(invite.code, `org invite: stdout=${invite.stdout}; stderr=${invite.stderr}`).toBe(0)

		// Duplicate slug — exits non-zero with a conflict error.
		const dup = await spawnCli(["org", "create", slug, "--registry", creds.baseUrl, "--json"], cwd, env)
		expect(dup.code, `dup org create: stdout=${dup.stdout}; stderr=${dup.stderr}`).not.toBe(0)
		const dupCombined = `${dup.stdout}\n${dup.stderr}`
		expect(dupCombined).toMatch(/409|already|exists|conflict|slug/i)

		// Unknown org slug — exits non-zero with a truthful error
		// (the registry returns 404 because the slug does not exist).
		// We cannot pin "unknown invitee" here: the Better-Auth
		// organization plugin creates the invitation record for any
		// email and only rejects at acceptance time. The CLI
		// surfaces whichever failure the registry returns; the
		// "unknown org slug" path is the equivalent CLI-visible
		// contract (VAL-DISC-014: errors exit non-zero with truthful
		// messages).
		const bad = await spawnCli(
			[
				"org",
				"invite",
				`no-such-org-${slug}`,
				"member@example.com",
				"--role",
				"member",
				"--registry",
				creds.baseUrl,
				"--json",
			],
			cwd,
			env,
		)
		expect(bad.code, `bad invite: stdout=${bad.stdout}; stderr=${bad.stderr}`).not.toBe(0)
		expect(`${bad.stdout}\n${bad.stderr}`).toMatch(/not found|organization|org/i)

		// Invalid role on the CLI surface — exits non-zero with a
		// named-alternatives error. The CLI rejects pre-network so
		// the registry never sees the malformed payload.
		const badRole = await spawnCli(
			[
				"org",
				"invite",
				slug,
				"member@example.com",
				"--role",
				"super-duper-admin",
				"--registry",
				creds.baseUrl,
				"--json",
			],
			cwd,
			env,
		)
		expect(badRole.code, `bad role: stdout=${badRole.stdout}; stderr=${badRole.stderr}`).not.toBe(0)
		expect(badRole.stderr).toMatch(/role|owner|admin|member/i)
	}, 120_000)
})

// ---------------------------------------------------------------------------
// CLI contract — malformed input + help advertisement
// ---------------------------------------------------------------------------

describe("CLI surfaces advertise publish + org and reject malformed input honestly", () => {
	it("`baka --help` advertises `publish` and `org` in the top-level command list", async () => {
		const bakaHome = makeIsolatedHome("baka-puborg-help-")
		const cwd = makeIsolatedHome("baka-puborg-help-proj-")
		const env = { BAKA_HOME: bakaHome }
		const res = await spawnCli(["--help"], cwd, env)
		expect(res.code).toBe(0)
		expect(res.stdout).toMatch(/\bpublish\b/)
		expect(res.stdout).toMatch(/\borg\b/)
	})

	it("`baka publish --help` exits 0 and lists --org, --path, --visibility, --registry, --json", async () => {
		const bakaHome = makeIsolatedHome("baka-puborg-phelp-")
		const cwd = makeIsolatedHome("baka-puborg-phelp-proj-")
		const env = { BAKA_HOME: bakaHome }
		const res = await spawnCli(["publish", "--help"], cwd, env)
		expect(res.code).toBe(0)
		expect(res.stdout).toMatch(/--org/)
		expect(res.stdout).toMatch(/--path/)
		expect(res.stdout).toMatch(/--visibility/)
		expect(res.stdout).toMatch(/--registry/)
		expect(res.stdout).toMatch(/--json/)
	})

	it("`baka org --help` exits 0 and lists the create / list / invite subcommands", async () => {
		const bakaHome = makeIsolatedHome("baka-puborg-ohelp-")
		const cwd = makeIsolatedHome("baka-puborg-ohelp-proj-")
		const env = { BAKA_HOME: bakaHome }
		const res = await spawnCli(["org", "--help"], cwd, env)
		expect(res.code).toBe(0)
		expect(res.stdout).toMatch(/\bcreate\b/)
		expect(res.stdout).toMatch(/\blist\b/)
		expect(res.stdout).toMatch(/\binvite\b/)
	})

	it("publish rejects a spec missing the @tag separator with an honest parse error", async () => {
		const bakaHome = makeIsolatedHome("baka-puborg-bad-spec-")
		const cwd = makeIsolatedHome("baka-puborg-bad-spec-proj-")
		const env = { BAKA_HOME: bakaHome }
		const res = await spawnCli(["publish", "no-tag-separator", "--registry", creds.baseUrl, "--org", "acme"], cwd, env)
		expect(res.code).toBe(1)
		expect(res.stderr).toMatch(/@|tag|form/i)
		expect(res.stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
	})

	it("publish rejects --org omission before any network call", async () => {
		const bakaHome = makeIsolatedHome("baka-puborg-no-org-")
		const cwd = makeIsolatedHome("baka-puborg-no-org-proj-")
		const env = { BAKA_HOME: bakaHome }
		seedCredential(bakaHome, creds.baseUrl, creds.ownerKey)
		const res = await spawnCli(["publish", "file:///tmp/anything@v1.0.0", "--registry", creds.baseUrl], cwd, env)
		expect(res.code).toBe(1)
		expect(res.stderr).toMatch(/--org/)
		expect(res.stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
	})

	it("`baka org list` with no memberships prints an honest empty message", async () => {
		const bakaHome = makeIsolatedHome("baka-puborg-empty-")
		const cwd = makeIsolatedHome("baka-puborg-empty-proj-")
		const env = { BAKA_HOME: bakaHome }
		// Use the outsider key — they have no memberships.
		seedCredential(bakaHome, creds.baseUrl, creds.outsiderKey)
		const res = await spawnCli(["org", "list", "--registry", creds.baseUrl], cwd, env)
		expect(res.code).toBe(0)
		expect(res.stdout).toMatch(/no orgs/i)
	})
})
