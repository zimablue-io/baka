import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLock, PackRegistry, writeLockfile } from "@repo/ast-tooling"
import { afterEach, describe, expect, it } from "vitest"
import { createEngineApp } from "./app.js"

const cleanup: string[] = []
afterEach(() => {
	for (const d of cleanup.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	}
})

function fixtureProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "baka-engine-"))
	cleanup.push(dir)
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe", private: true }))
	const packRoot = join(dir, "packs", "hello")
	const templates = join(packRoot, "greet", "templates")
	mkdirSync(templates, { recursive: true })
	writeFileSync(
		join(packRoot, "manifest.ts"),
		`export const Manifest = {
  name: "hello",
  version: "0.0.0",
  description: "fixture",
  dependencies: [],
  conflictsWith: [],
  recipes: [{
    id: "greet",
    description: "write a greeting",
    params: [{ name: "name", type: "string", required: true, description: "who" }],
    requiresReasoning: false,
    filePatterns: ["hello.md"],
    validators: [],
  }],
  packValidators: [],
}
`,
	)
	writeFileSync(
		join(templates, "hello.md.hbs"),
		`# {{name}}\n{{#slot "blurb" kind="prose" max=80}}one sentence{{/slot}}\n`,
	)
	return dir
}

describe("engine Hono SSOT", () => {
	it("echoes localhost Origin so the desktop Vite UI can fetch", async () => {
		const app = createEngineApp({ cwd: fixtureProject() })
		const res = await app.request("/v1/packs", {
			headers: { Origin: "http://localhost:1420" },
		})
		expect(res.status).toBe(200)
		expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:1420")
	})

	it("lists packs over GET /v1/packs", async () => {
		const cwd = fixtureProject()
		const app = createEngineApp({ cwd })
		const res = await app.request("/v1/packs")
		expect(res.status).toBe(200)
		const body = (await res.json()) as { packs: Array<{ name: string }> }
		expect(body.packs.map((m) => m.name)).toContain("hello")
	})

	it("lists slots over GET /v1/slots", async () => {
		const cwd = fixtureProject()
		const app = createEngineApp({ cwd })
		const res = await app.request("/v1/slots?pack=hello&recipe=greet")
		expect(res.status).toBe(200)
		const body = (await res.json()) as { slots: Array<{ id: string }> }
		expect(body.slots.map((s) => s.id)).toEqual(["blurb"])
	})

	it("fills a slot manually and materializes a byte-identical tree on two runs", async () => {
		const cwd = fixtureProject()
		const app = createEngineApp({ cwd })
		const fill = await app.request("/v1/fill", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				pack: "hello",
				recipe: "greet",
				slot: "blurb",
				value: "A greeting.",
				params: { name: "Ada" },
			}),
		})
		expect(fill.status).toBe(200)

		const run1 = await app.request("/v1/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pack: "hello", recipe: "greet", params: { name: "Ada" } }),
		})
		expect(run1.status).toBe(200)
		const body1 = (await run1.json()) as { ok: boolean; changeset: unknown[]; outputTreeHash: string }
		expect(body1.ok).toBe(true)
		expect(readFileSync(join(cwd, "hello.md"), "utf-8")).toBe("# Ada\nA greeting.\n")

		const cwd2 = fixtureProject()
		const app2 = createEngineApp({ cwd: cwd2 })
		await app2.request("/v1/fill", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				pack: "hello",
				recipe: "greet",
				slot: "blurb",
				value: "A greeting.",
				params: { name: "Ada" },
			}),
		})
		const run2 = await app2.request("/v1/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pack: "hello", recipe: "greet", params: { name: "Ada" } }),
		})
		const body2 = (await run2.json()) as { changeset: unknown[]; outputTreeHash: string }
		expect(body2.changeset).toEqual(body1.changeset)
		expect(body2.outputTreeHash).toBe(body1.outputTreeHash)
	})

	it("GET /v1/preview returns the template documents for any recipe", async () => {
		const cwd = fixtureProject()
		const app = createEngineApp({ cwd })
		const res = await app.request("/v1/preview?pack=hello&recipe=greet")
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			params: Array<{ name: string }>
			files: Array<{ rel: string; source: string }>
			slots: Array<{ id: string }>
		}
		expect(body.params.map((p) => p.name)).toEqual(["name"])
		expect(body.files).toEqual([
			{
				rel: "hello.md.hbs",
				source: `# {{name}}\n{{#slot "blurb" kind="prose" max=80}}one sentence{{/slot}}\n`,
			},
		])
		expect(body.slots.map((s) => s.id)).toEqual(["blurb"])
	})

	it("uses an allowed project for discovery and writes, so one serve can drive other trees", async () => {
		const project = fixtureProject()
		const bind = mkdtempSync(join(tmpdir(), "baka-engine-bind-"))
		cleanup.push(bind)
		writeFileSync(join(bind, "package.json"), JSON.stringify({ name: "bind", private: true }))
		const app = createEngineApp({ cwd: bind, allowedRoots: [tmpdir()] })
		const listed = await app.request(`/v1/packs?project=${encodeURIComponent(project)}`)
		const listedBody = (await listed.json()) as { packs: Array<{ name: string }> }
		expect(listedBody.packs.map((m) => m.name)).toContain("hello")

		await app.request("/v1/fill", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project,
				pack: "hello",
				recipe: "greet",
				slot: "blurb",
				value: "A greeting.",
				params: { name: "Ada" },
			}),
		})
		const run = await app.request("/v1/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project,
				pack: "hello",
				recipe: "greet",
				params: { name: "Ada" },
			}),
		})
		expect(run.status).toBe(200)
		expect(readFileSync(join(project, "hello.md"), "utf-8")).toBe("# Ada\nA greeting.\n")
		expect(() => readFileSync(join(bind, "hello.md"), "utf-8")).toThrow()
	})

	it("replays slot records over POST /v1/run: same tree hash, and a missing record is a typed 400", async () => {
		const recordedCwd = fixtureProject()
		const recordedApp = createEngineApp({ cwd: recordedCwd })
		await recordedApp.request("/v1/fill", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				pack: "hello",
				recipe: "greet",
				slot: "blurb",
				value: "A greeting.",
				params: { name: "Ada" },
			}),
		})
		const run = (app: ReturnType<typeof createEngineApp>, body: unknown) =>
			app.request("/v1/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			})
		const recorded = (await (
			await run(recordedApp, { pack: "hello", recipe: "greet", params: { name: "Ada" } })
		).json()) as {
			outputTreeHash: string
			slots: unknown[]
		}

		const replayApp = createEngineApp({ cwd: fixtureProject() })
		const replayed = await run(replayApp, {
			pack: "hello",
			recipe: "greet",
			params: { name: "Ada" },
			slots: { mode: "replay", records: recorded.slots },
		})
		expect(replayed.status).toBe(200)
		expect(((await replayed.json()) as { outputTreeHash: string }).outputTreeHash).toBe(recorded.outputTreeHash)

		const missing = await run(createEngineApp({ cwd: fixtureProject() }), {
			pack: "hello",
			recipe: "greet",
			params: { name: "Ada" },
			slots: { mode: "replay", records: [] },
		})
		expect(missing.status).toBe(400)
		const body = (await missing.json()) as { ok: boolean; diagnostics: Array<{ rule: string }> }
		expect(body.ok).toBe(false)
		expect(body.diagnostics.map((d) => d.rule)).toEqual(["slot-record-missing"])
	})

	it("holds a project with a baka.lock.json to it: a changed pack is a typed 400", async () => {
		const cwd = fixtureProject()
		writeLockfile(cwd, createLock(new PackRegistry(cwd)))
		const app = createEngineApp({ cwd })
		const post = () =>
			app.request("/v1/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ pack: "hello", recipe: "greet", params: { name: "Ada" }, dryRun: true }),
			})
		// dry run needs a fill; pin one so the only possible failure is the lock
		await app.request("/v1/fill", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				pack: "hello",
				recipe: "greet",
				slot: "blurb",
				value: "A greeting.",
				params: { name: "Ada" },
			}),
		})
		const ok = await post()
		expect(ok.status).toBe(200)
		const pins = ((await ok.json()) as { pins: Array<{ id: string }> }).pins
		expect(pins.map((p) => p.id)).toEqual(["hello"])

		writeFileSync(join(cwd, "packs", "hello", "greet", "templates", "hello.md.hbs"), "# tampered\n")
		const blocked = await post()
		expect(blocked.status).toBe(400)
		const body = (await blocked.json()) as { ok: boolean; diagnostics: Array<{ rule: string }> }
		expect(body.ok).toBe(false)
		expect(body.diagnostics.map((d) => d.rule)).toEqual(["lock-mismatch"])
	})

	it("honours onExisting over POST /v1/run: fail is a typed 400, overwrite rewrites", async () => {
		const cwd = fixtureProject()
		const app = createEngineApp({ cwd })
		await app.request("/v1/fill", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				pack: "hello",
				recipe: "greet",
				slot: "blurb",
				value: "A greeting.",
				params: { name: "Ada" },
			}),
		})
		const run = (onExisting?: string) =>
			app.request("/v1/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ pack: "hello", recipe: "greet", params: { name: "Ada" }, onExisting }),
			})
		expect((await run()).status).toBe(200)
		writeFileSync(join(cwd, "hello.md"), "edited\n")

		const skipped = (await (await run("skip")).json()) as { changeset: Array<{ op: string; reason?: string }> }
		expect(skipped.changeset).toMatchObject([{ op: "skip", reason: "already-exists" }])
		expect(readFileSync(join(cwd, "hello.md"), "utf-8")).toBe("edited\n")

		const failed = await run("fail")
		expect(failed.status).toBe(400)
		expect(((await failed.json()) as { diagnostics: Array<{ rule: string }> }).diagnostics[0]?.rule).toBe(
			"target-exists",
		)

		const overwritten = (await (await run("overwrite")).json()) as { changeset: Array<{ op: string }> }
		expect(overwritten.changeset).toMatchObject([{ op: "update" }])
		expect(readFileSync(join(cwd, "hello.md"), "utf-8")).toBe("# Ada\nA greeting.\n")
	})
})

describe("engine authentication", () => {
	const TOKEN = "correct-horse-battery-staple"

	it("serves everything without credentials when no token is configured", async () => {
		const app = createEngineApp({ cwd: fixtureProject() })
		expect((await app.request("/v1/packs")).status).toBe(200)
	})

	it("rejects a request with no credentials, with a Bearer challenge and no detail", async () => {
		const app = createEngineApp({ cwd: fixtureProject(), token: TOKEN })
		for (const [path, method] of [
			["/v1/packs", "GET"],
			["/v1/slots?pack=hello&recipe=greet", "GET"],
			["/v1/preview?pack=hello&recipe=greet", "GET"],
			["/v1/run", "POST"],
			["/v1/fill", "POST"],
			["/v1/validate", "POST"],
			["/mcp", "GET"],
		] as const) {
			const res = await app.request(path, { method })
			expect(res.status, `${method} ${path}`).toBe(401)
			expect(res.headers.get("www-authenticate")).toBe("Bearer")
			expect(JSON.stringify(await res.json())).not.toContain(TOKEN)
		}
	})

	it("rejects a wrong token, a wrong scheme, and a token with extra text", async () => {
		const app = createEngineApp({ cwd: fixtureProject(), token: TOKEN })
		for (const authorization of [
			"Bearer nope",
			`Basic ${TOKEN}`,
			TOKEN,
			`Bearer ${TOKEN}x`,
			`Bearer ${TOKEN} extra`,
			"Bearer",
			"",
		]) {
			const res = await app.request("/v1/packs", { headers: { authorization } })
			expect(res.status, authorization).toBe(401)
		}
	})

	it("accepts the right token on every route", async () => {
		const cwd = fixtureProject()
		const app = createEngineApp({ cwd, token: TOKEN })
		const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }
		expect((await app.request("/v1/packs", { headers })).status).toBe(200)
		expect((await app.request("/v1/slots?pack=hello&recipe=greet", { headers })).status).toBe(200)
		expect((await app.request("/v1/validate", { method: "POST", headers, body: "{}" })).status).toBe(200)
		expect((await app.request("/mcp", { headers })).status).toBe(501)
		// scheme matching is case-insensitive, as RFC 7235 requires
		const lower = await app.request("/v1/packs", { headers: { authorization: `bearer ${TOKEN}` } })
		expect(lower.status).toBe(200)
	})

	it("answers a CORS preflight without credentials so a browser can then send the token", async () => {
		const app = createEngineApp({ cwd: fixtureProject(), token: TOKEN })
		const res = await app.request("/v1/run", {
			method: "OPTIONS",
			headers: {
				Origin: "http://localhost:1420",
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "authorization,content-type",
			},
		})
		expect(res.status).toBeLessThan(300)
		expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:1420")
	})
})

describe("engine project allow-list", () => {
	function bindDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "baka-engine-bind-"))
		cleanup.push(dir)
		return dir
	}
	const packsUrl = (project: string) => `/v1/packs?project=${encodeURIComponent(project)}`

	it("refuses any other absolute project when no roots are configured", async () => {
		const other = fixtureProject()
		const app = createEngineApp({ cwd: bindDir() })
		const res = await app.request(packsUrl(other))
		expect(res.status).toBe(403)
		expect(((await res.json()) as { error: string }).error).toContain("--allow-root")
	})

	it("refuses on every route that takes a project, and never writes there", async () => {
		const other = fixtureProject()
		const app = createEngineApp({ cwd: bindDir() })
		const post = (path: string, body: unknown) =>
			app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
		const target = { pack: "hello", recipe: "greet", project: other }
		expect((await app.request(`/v1/slots?pack=hello&recipe=greet&project=${encodeURIComponent(other)}`)).status).toBe(
			403,
		)
		expect((await app.request(`/v1/preview?pack=hello&recipe=greet&project=${encodeURIComponent(other)}`)).status).toBe(
			403,
		)
		expect((await post("/v1/run", { ...target, params: { name: "Ada" } })).status).toBe(403)
		expect((await post("/v1/fill", { ...target, slot: "blurb", value: "x", params: { name: "Ada" } })).status).toBe(403)
		expect((await post("/v1/validate", { project: other })).status).toBe(403)
		expect(() => readFileSync(join(other, "hello.md"), "utf-8")).toThrow()
		expect(() => readFileSync(join(other, ".baka"), "utf-8")).toThrow()
	})

	it("still allows naming the engine's own cwd explicitly", async () => {
		const cwd = fixtureProject()
		const app = createEngineApp({ cwd })
		expect((await app.request(packsUrl(cwd))).status).toBe(200)
	})

	it("rejects relative and missing paths as malformed (400), not forbidden", async () => {
		const app = createEngineApp({ cwd: bindDir(), allowedRoots: [tmpdir()] })
		expect((await app.request(packsUrl("relative/dir"))).status).toBe(400)
		expect((await app.request(packsUrl(join(tmpdir(), "baka-does-not-exist-xyz")))).status).toBe(400)
	})

	it("allows a project inside an allowed root and the root itself", async () => {
		const root = bindDir()
		const inside = join(root, "nested", "project")
		mkdirSync(inside, { recursive: true })
		const app = createEngineApp({ cwd: bindDir(), allowedRoots: [root] })
		expect((await app.request(packsUrl(inside))).status).toBe(200)
		expect((await app.request(packsUrl(root))).status).toBe(200)
	})

	it("refuses a project outside the allowed roots, including `..` escapes and sibling-prefix names", async () => {
		const parent = bindDir()
		const root = join(parent, "allowed")
		const sibling = join(parent, "allowed-evil")
		mkdirSync(root)
		mkdirSync(sibling)
		const app = createEngineApp({ cwd: bindDir(), allowedRoots: [root] })
		expect((await app.request(packsUrl(sibling))).status).toBe(403)
		expect((await app.request(packsUrl(join(root, "..", "allowed-evil")))).status).toBe(403)
		expect((await app.request(packsUrl(parent))).status).toBe(403)
	})

	it("resolves symlinks, so a link inside a root cannot lead outside it", async () => {
		const parent = bindDir()
		const root = join(parent, "allowed")
		const outside = join(parent, "outside")
		mkdirSync(root)
		mkdirSync(outside)
		symlinkSync(outside, join(root, "escape"))
		const app = createEngineApp({ cwd: bindDir(), allowedRoots: [root] })
		expect((await app.request(packsUrl(join(root, "escape")))).status).toBe(403)
	})

	it("answers malformed JSON with 400, not a crash", async () => {
		const app = createEngineApp({ cwd: bindDir() })
		const res = await app.request("/v1/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{nope",
		})
		expect(res.status).toBe(400)
		expect(((await res.json()) as { error: string }).error).toContain("JSON")
	})
})

describe("engine run: path containment", () => {
	function scaffoldProject(): { base: string; cwd: string } {
		const base = mkdtempSync(join(tmpdir(), "baka-engine-contain-"))
		cleanup.push(base)
		const cwd = join(base, "project")
		const packRoot = join(cwd, "packs", "scaf")
		mkdirSync(join(packRoot, "scaffold", "templates", "{{name}}"), { recursive: true })
		writeFileSync(
			join(packRoot, "manifest.ts"),
			`export const Manifest = {
  name: "scaf", version: "0.0.0", description: "fixture", dependencies: [], conflictsWith: [],
  recipes: [{ id: "scaffold", description: "x", requiresReasoning: false, filePatterns: [], validators: [],
    params: [{ name: "name", type: "string", required: true, description: "n" }] }],
  packValidators: [],
}
`,
		)
		writeFileSync(join(packRoot, "scaffold", "templates", "{{name}}", "README.md.hbs"), "# {{name}}\n")
		return { base, cwd }
	}

	it("refuses --name ../../x over HTTP and writes nothing above the project", async () => {
		const { base, cwd } = scaffoldProject()
		const app = createEngineApp({ cwd })
		const res = await app.request("/v1/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pack: "scaf", recipe: "scaffold", params: { name: "../../x" } }),
		})
		expect(res.status).toBe(400)
		const body = (await res.json()) as { ok: boolean; diagnostics: Array<{ rule: string }> }
		expect(body.ok).toBe(false)
		expect(body.diagnostics.map((d) => d.rule)).toEqual(["path-escape"])
		expect(readdirSync(base)).toEqual(["project"])
		expect(readdirSync(cwd)).toEqual(["packs"])
	})
})

describe("engine run: validates by default, as runRecipe does", () => {
	function failingValidatorProject(): string {
		const dir = mkdtempSync(join(tmpdir(), "baka-engine-validate-"))
		cleanup.push(dir)
		const packRoot = join(dir, "packs", "chk")
		mkdirSync(join(packRoot, "gen", "templates"), { recursive: true })
		mkdirSync(join(packRoot, "gen", "validators"), { recursive: true })
		writeFileSync(
			join(packRoot, "manifest.ts"),
			`export const Manifest = {
  name: "chk", version: "0.0.0", description: "fixture", dependencies: [], conflictsWith: [],
  recipes: [{ id: "gen", description: "x", requiresReasoning: false, filePatterns: [], params: [], validators: ["alwaysFails"] }],
  packValidators: [],
}
`,
		)
		writeFileSync(join(packRoot, "gen", "templates", "out.txt.hbs"), "out\n")
		writeFileSync(
			join(packRoot, "gen", "validators", "always-fails.ts"),
			`export async function alwaysFails() { return [{ severity: "error", rule: "nope", message: "scaffold is wrong" }] }\n`,
		)
		return dir
	}

	const post = (cwd: string, body: Record<string, unknown>) =>
		createEngineApp({ cwd }).request("/v1/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pack: "chk", recipe: "gen", params: {}, ...body }),
		})

	it("reports ok:false for a failing validator when the caller says nothing about validate", async () => {
		const res = await post(failingValidatorProject(), {})
		expect(res.status).toBe(400)
		const body = (await res.json()) as { ok: boolean; diagnostics: Array<{ rule: string; validator?: string }> }
		expect(body.ok).toBe(false)
		expect(body.diagnostics).toEqual([
			expect.objectContaining({ rule: "nope", validator: "chk.gen:alwaysFails", severity: "error" }),
		])
	})

	it("skips validators only when asked to", async () => {
		const res = await post(failingValidatorProject(), { validate: false })
		expect(res.status).toBe(200)
		expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
	})
})

describe("engine fill: params are normalised the way a run normalises them", () => {
	function projectWithDefaults(): string {
		const dir = mkdtempSync(join(tmpdir(), "baka-engine-fill-"))
		cleanup.push(dir)
		const root = join(dir, "packs", "note")
		mkdirSync(join(root, "write", "templates"), { recursive: true })
		writeFileSync(
			join(root, "manifest.ts"),
			`export const Manifest = { name: "note", version: "0.0.0", description: "x", dependencies: [], conflictsWith: [],
  recipes: [{ id: "write", description: "x", requiresReasoning: true, filePatterns: [], validators: [], params: [
    { name: "title", type: "string", required: true, description: "t" },
    { name: "tone", type: "string", required: false, description: "t", default: "plain" },
    { name: "count", type: "number", required: false, description: "t", default: 1 },
  ] }], packValidators: [] }
`,
		)
		writeFileSync(
			join(root, "write", "templates", "note.md.hbs"),
			`# {{title}} ({{tone}} x{{count}})\n{{#slot "line" kind="prose" max=40}}one sentence{{/slot}}\n`,
		)
		return dir
	}

	const post = (app: ReturnType<typeof createEngineApp>, path: string, body: unknown) =>
		app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

	it("replays a fill made with the params as typed in a run that spells them differently", async () => {
		const cwd = projectWithDefaults()
		const app = createEngineApp({ cwd })
		// Typed: only the required param, the count as a string (what a CLI flag gives).
		const fill = await post(app, "/v1/fill", {
			pack: "note",
			recipe: "write",
			slot: "line",
			value: "Pinned.",
			params: { title: "Probe", count: "3" },
		})
		expect(fill.status).toBe(200)

		for (const params of [
			{ title: "Probe", count: "3" },
			{ title: "Probe", count: 3 },
			{ title: "Probe", tone: "plain", count: 3 },
		]) {
			const run = await post(app, "/v1/run", { pack: "note", recipe: "write", params, onExisting: "overwrite" })
			const body = (await run.json()) as { ok: boolean; slots: Array<{ source: string }> }
			expect(body.ok, JSON.stringify(params)).toBe(true)
			expect(body.slots.map((s) => s.source)).toEqual(["cache"])
		}
		expect(readFileSync(join(cwd, "note.md"), "utf-8")).toBe("# Probe (plain x3)\nPinned.\n")
	})

	it("refuses a fill whose params a run would refuse", async () => {
		const app = createEngineApp({ cwd: projectWithDefaults() })
		const fill = await post(app, "/v1/fill", {
			pack: "note",
			recipe: "write",
			slot: "line",
			value: "Pinned.",
			params: { count: "many" },
		})
		expect(fill.status).toBe(400)
		const body = (await fill.json()) as { error: string }
		expect(body.error).toMatch(/params for note\/write/)
	})
})

describe("engine packDirs: packs come from elsewhere, output goes to the project", () => {
	it("lists and runs a catalog pack without writing into the catalog", async () => {
		const catalog = mkdtempSync(join(tmpdir(), "baka-engine-catalog-"))
		const project = mkdtempSync(join(tmpdir(), "baka-engine-project-"))
		cleanup.push(catalog, project)
		const packRoot = join(catalog, "hello")
		mkdirSync(join(packRoot, "greet", "templates"), { recursive: true })
		writeFileSync(
			join(packRoot, "manifest.ts"),
			`export const Manifest = { name: "hello", version: "0.0.0", description: "x", dependencies: [], conflictsWith: [],
  recipes: [{ id: "greet", description: "x", requiresReasoning: false, filePatterns: [], validators: [], params: [] }], packValidators: [] }
`,
		)
		writeFileSync(join(packRoot, "greet", "templates", "hi.txt.hbs"), "hi\n")
		const app = createEngineApp({ cwd: project, packDirs: [catalog] })
		const listed = (await (await app.request("/v1/packs")).json()) as { packs: Array<{ name: string }> }
		expect(listed.packs.map((m) => m.name)).toEqual(["hello"])
		const res = await app.request("/v1/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pack: "hello", recipe: "greet", params: {} }),
		})
		expect(res.status).toBe(200)
		expect(readFileSync(join(project, "hi.txt"), "utf-8")).toBe("hi\n")
		expect(readdirSync(catalog)).toEqual(["hello"])
		expect(readdirSync(packRoot).sort()).toEqual(["greet", "manifest.ts"])
		expect(readdirSync(project).filter((n) => n !== ".baka")).toEqual(["hi.txt"])
	})
})

describe("engine packDirs from the project's .baka/settings.json", () => {
	function projectWithSettings(packDirs: string[]): { project: string; catalog: string } {
		const parent = mkdtempSync(join(tmpdir(), "baka-engine-settings-"))
		cleanup.push(parent)
		const project = join(parent, "project")
		const catalog = join(parent, "catalog")
		mkdirSync(join(project, ".baka"), { recursive: true })
		mkdirSync(join(catalog, "hello", "greet", "templates"), { recursive: true })
		writeFileSync(
			join(catalog, "hello", "manifest.ts"),
			`export const Manifest = { name: "hello", version: "0.0.0", description: "x", dependencies: [], conflictsWith: [],
  recipes: [{ id: "greet", description: "x", requiresReasoning: false, filePatterns: [], validators: [], params: [] }], packValidators: [] }
`,
		)
		writeFileSync(join(catalog, "hello", "greet", "templates", "hi.txt.hbs"), "hi\n")
		writeFileSync(join(project, ".baka", "settings.json"), JSON.stringify({ packDirs }))
		return { project, catalog }
	}

	it("serves the listed catalog when the engine was given no packDirs", async () => {
		const { project } = projectWithSettings(["../catalog"])
		const app = createEngineApp({ cwd: project })
		const listed = (await (await app.request("/v1/packs")).json()) as { packs: Array<{ name: string }> }
		expect(listed.packs.map((m) => m.name)).toEqual(["hello"])
	})

	it("answers 400 with the file, the entry and the fix when a listed directory is missing", async () => {
		const { project } = projectWithSettings(["../missing"])
		const app = createEngineApp({ cwd: project })
		for (const path of ["/v1/packs", "/v1/slots?pack=hello&recipe=greet", "/v1/preview?pack=hello&recipe=greet"]) {
			const res = await app.request(path)
			expect(res.status, path).toBe(400)
			const body = (await res.json()) as { error: string }
			expect(body.error).toContain(join(project, ".baka", "settings.json"))
			expect(body.error).toContain("packDirs[0]")
		}
		const run = await app.request("/v1/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pack: "hello", recipe: "greet", params: {} }),
		})
		expect(run.status).toBe(400)
	})

	it("is overridden by the packDirs the engine was started with", async () => {
		const { project } = projectWithSettings(["../missing"])
		const other = mkdtempSync(join(tmpdir(), "baka-engine-other-"))
		cleanup.push(other)
		const app = createEngineApp({ cwd: project, packDirs: [other] })
		const res = await app.request("/v1/packs")
		expect(res.status).toBe(200)
	})
})

describe("engine run: format", () => {
	it("runs the formatter the recipe declares only when the request says format: true", async () => {
		const dir = mkdtempSync(join(tmpdir(), "baka-engine-format-"))
		cleanup.push(dir)
		const packRoot = join(dir, "packs", "fmt")
		mkdirSync(join(packRoot, "gen", "templates"), { recursive: true })
		const formatter = {
			command: process.execPath,
			args: ["-e", "for (const f of process.argv.slice(1)) require('fs').writeFileSync(f, 'formatted\\n')", "{files}"],
		}
		writeFileSync(
			join(packRoot, "manifest.ts"),
			`export const Manifest = { name: "fmt", version: "0.0.0", description: "x", dependencies: [], conflictsWith: [],
  recipes: [{ id: "gen", description: "x", requiresReasoning: false, filePatterns: [], validators: [], params: [], format: ${JSON.stringify(formatter)} }],
  packValidators: [] }
`,
		)
		writeFileSync(join(packRoot, "gen", "templates", "out.txt.hbs"), "raw\n")
		const app = createEngineApp({ cwd: dir })
		const post = (body: Record<string, unknown>) =>
			app.request("/v1/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ pack: "fmt", recipe: "gen", params: {}, ...body }),
			})
		expect((await post({})).status).toBe(200)
		expect(readFileSync(join(dir, "out.txt"), "utf-8")).toBe("raw\n")
		rmSync(join(dir, "out.txt"))
		expect((await post({ format: true })).status).toBe(200)
		expect(readFileSync(join(dir, "out.txt"), "utf-8")).toBe("formatted\n")
	})
})
