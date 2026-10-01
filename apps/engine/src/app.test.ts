import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
	const moduleRoot = join(dir, "modules", "hello")
	const templates = join(moduleRoot, "greet", "templates")
	mkdirSync(templates, { recursive: true })
	writeFileSync(
		join(moduleRoot, "manifest.ts"),
		`export const Manifest = {
  name: "hello",
  version: "0.0.0",
  description: "fixture",
  dependencies: [],
  conflictsWith: [],
  actions: [{
    id: "greet",
    description: "write a greeting",
    params: [{ name: "name", type: "string", required: true, description: "who" }],
    requiresReasoning: false,
    filePatterns: ["hello.md"],
    validators: [],
  }],
  moduleValidators: [],
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
		const res = await app.request("/v1/modules", {
			headers: { Origin: "http://localhost:1420" },
		})
		expect(res.status).toBe(200)
		expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:1420")
	})

	it("lists modules over GET /v1/modules", async () => {
		const cwd = fixtureProject()
		const app = createEngineApp({ cwd })
		const res = await app.request("/v1/modules")
		expect(res.status).toBe(200)
		const body = (await res.json()) as { modules: Array<{ name: string }> }
		expect(body.modules.map((m) => m.name)).toContain("hello")
	})

	it("lists slots over GET /v1/slots", async () => {
		const cwd = fixtureProject()
		const app = createEngineApp({ cwd })
		const res = await app.request("/v1/slots?module=hello&action=greet")
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
				module: "hello",
				action: "greet",
				slot: "blurb",
				value: "A greeting.",
				params: { name: "Ada" },
			}),
		})
		expect(fill.status).toBe(200)

		const run1 = await app.request("/v1/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ module: "hello", action: "greet", params: { name: "Ada" } }),
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
				module: "hello",
				action: "greet",
				slot: "blurb",
				value: "A greeting.",
				params: { name: "Ada" },
			}),
		})
		const run2 = await app2.request("/v1/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ module: "hello", action: "greet", params: { name: "Ada" } }),
		})
		const body2 = (await run2.json()) as { changeset: unknown[]; outputTreeHash: string }
		expect(body2.changeset).toEqual(body1.changeset)
		expect(body2.outputTreeHash).toBe(body1.outputTreeHash)
	})

	it("GET /v1/preview returns the template documents for any action", async () => {
		const cwd = fixtureProject()
		const app = createEngineApp({ cwd })
		const res = await app.request("/v1/preview?module=hello&action=greet")
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

	it("uses project for discovery and writes, so one serve can drive any tree", async () => {
		const project = fixtureProject()
		const bind = mkdtempSync(join(tmpdir(), "baka-engine-bind-"))
		cleanup.push(bind)
		writeFileSync(join(bind, "package.json"), JSON.stringify({ name: "bind", private: true }))
		const app = createEngineApp({ cwd: bind })
		const listed = await app.request(`/v1/modules?project=${encodeURIComponent(project)}`)
		const listedBody = (await listed.json()) as { modules: Array<{ name: string }> }
		expect(listedBody.modules.map((m) => m.name)).toContain("hello")

		await app.request("/v1/fill", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project,
				module: "hello",
				action: "greet",
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
				module: "hello",
				action: "greet",
				params: { name: "Ada" },
			}),
		})
		expect(run.status).toBe(200)
		expect(readFileSync(join(project, "hello.md"), "utf-8")).toBe("# Ada\nA greeting.\n")
		expect(() => readFileSync(join(bind, "hello.md"), "utf-8")).toThrow()
	})
})
