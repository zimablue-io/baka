import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createEngineApp } from "./app.js"

const cleanup: string[] = []
const servers: Server[] = []
const savedHome = process.env.BAKA_HOME
const savedKey = process.env.PER_CALL_KEY

beforeEach(() => {
	// Every test starts with an empty user directory, so nothing here depends on the machine's own ~/.baka.
	process.env.BAKA_HOME = tempDir("baka-home-")
})

afterEach(async () => {
	if (savedHome === undefined) delete process.env.BAKA_HOME
	else process.env.BAKA_HOME = savedHome
	if (savedKey === undefined) delete process.env.PER_CALL_KEY
	else process.env.PER_CALL_KEY = savedKey
	for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	cleanup.push(dir)
	return dir
}

const MANIFEST = (name: string, recipe: string) => `export const Manifest = {
  name: ${JSON.stringify(name)},
  version: "0.0.0",
  description: "fixture",
  dependencies: [],
  conflictsWith: [],
  recipes: [{
    id: ${JSON.stringify(recipe)},
    description: "write a greeting",
    params: [{ name: "name", type: "string", required: true, description: "who" }],
    requiresReasoning: false,
    filePatterns: ["hello.md"],
    validators: [],
  }],
  packValidators: [],
}
`

function writePack(packsDir: string, name: string, recipe: string): void {
	const root = join(packsDir, name)
	mkdirSync(join(root, recipe, "templates"), { recursive: true })
	writeFileSync(join(root, "manifest.ts"), MANIFEST(name, recipe))
	writeFileSync(
		join(root, recipe, "templates", "hello.md.hbs"),
		`# {{name}}\n{{#slot "blurb" kind="prose" max=80}}one sentence{{/slot}}\n`,
	)
}

function project(): string {
	const dir = tempDir("baka-engine-call-")
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe", private: true }))
	writePack(join(dir, "packs"), "hello", "greet")
	return dir
}

const post = (app: ReturnType<typeof createEngineApp>, path: string, body: unknown) =>
	app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

/** A chat-completions endpoint that answers every slot with `value` and counts the requests it receives. */
async function fakeModel(value: string): Promise<{ baseUrl: string; requests: string[] }> {
	const requests: string[] = []
	const server = createServer((req, res) => {
		let body = ""
		req.on("data", (chunk) => {
			body += chunk
		})
		req.on("end", () => {
			requests.push(`${req.headers.authorization ?? ""}|${body}`)
			res.setHeader("content-type", "application/json")
			res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ value }) } }], usage: {} }))
		})
	})
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests }
}

describe("a recipe by its own name", () => {
	it("POST /v1/run needs no pack when one pack declares the recipe", async () => {
		const cwd = project()
		const res = await post(createEngineApp({ cwd }), "/v1/run", {
			recipe: "greet",
			params: { name: "Ada" },
			slots: { mode: "live", values: { blurb: "Hi." } },
		})
		expect(res.status).toBe(200)
		expect(((await res.json()) as { pack: string }).pack).toBe("hello")
		expect(readFileSync(join(cwd, "hello.md"), "utf-8")).toBe("# Ada\nHi.\n")
	})

	it("answers recipe-ambiguous with the candidates when two packs declare it", async () => {
		const cwd = project()
		writePack(join(cwd, "packs"), "other", "greet")
		const res = await post(createEngineApp({ cwd }), "/v1/run", { recipe: "greet", params: { name: "Ada" } })
		expect(res.status).toBe(400)
		const body = (await res.json()) as { error: { code: string; message: string } }
		expect(body.error.code).toBe("recipe-ambiguous")
		expect(body.error.message).toContain("hello/greet")
		expect(body.error.message).toContain("other/greet")
	})

	it("GET /v1/slots and /v1/preview take a bare recipe too", async () => {
		const app = createEngineApp({ cwd: project() })
		const slots = (await (await app.request("/v1/slots?recipe=greet")).json()) as {
			pack: string
			slots: Array<{ id: string }>
		}
		expect(slots.pack).toBe("hello")
		expect(slots.slots.map((s) => s.id)).toEqual(["blurb"])
		expect((await app.request("/v1/preview?recipe=greet")).status).toBe(200)
	})
})

describe("a run with no model configured", () => {
	it("answers 400 with the receipt, whose openSlots say what to supply", async () => {
		const cwd = project()
		const res = await post(createEngineApp({ cwd }), "/v1/run", { recipe: "greet", params: { name: "Ada" } })
		expect(res.status).toBe(400)
		const body = (await res.json()) as {
			ok: boolean
			diagnostics: Array<{ rule: string }>
			openSlots: Array<{ id: string }>
		}
		expect(body.ok).toBe(false)
		expect(body.diagnostics.map((d) => d.rule)).toEqual(["slots-open"])
		expect(body.openSlots.map((s) => s.id)).toEqual(["blurb"])
	})
})

describe("errors are { error: { code, message, hint? } }", () => {
	it("on a request the engine refuses before running anything", async () => {
		const app = createEngineApp({ cwd: project() })
		const res = await app.request("/v1/slots")
		expect(res.status).toBe(400)
		expect(await res.json()).toEqual({
			error: { code: "bad-request", message: expect.stringContaining("recipe"), hint: expect.any(String) },
		})
	})

	it("on a body that is not JSON, and on one that does not fit", async () => {
		const app = createEngineApp({ cwd: project() })
		const notJson = await app.request("/v1/run", { method: "POST", body: "{" })
		expect(((await notJson.json()) as { error: { code: string } }).error.code).toBe("bad-request")
		const misfit = await post(app, "/v1/run", { params: {} })
		expect(((await misfit.json()) as { error: { code: string } }).error.code).toBe("bad-request")
	})

	it("on a missing token", async () => {
		const res = await createEngineApp({ cwd: project(), token: "t" }).request("/v1/packs")
		expect(res.status).toBe(401)
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized")
	})
})

describe("configuration passed per call", () => {
	it("uses the model the request names, with a key read from the environment variable it names", async () => {
		process.env.PER_CALL_KEY = "sekret"
		const model = await fakeModel("From the model.")
		const cwd = project()
		const res = await post(createEngineApp({ cwd }), "/v1/run", {
			recipe: "greet",
			params: { name: "Ada" },
			llm: { baseUrl: model.baseUrl, model: "tiny", apiKeyEnv: "PER_CALL_KEY" },
		})
		expect(res.status).toBe(200)
		expect(readFileSync(join(cwd, "hello.md"), "utf-8")).toContain("From the model.")
		expect(model.requests).toHaveLength(1)
		expect(model.requests[0]).toContain("Bearer sekret")
		expect(model.requests[0]).toContain('"model":"tiny"')
	})

	it("fails fast, naming the variable, when apiKeyEnv points at nothing", async () => {
		delete process.env.PER_CALL_KEY
		const res = await post(createEngineApp({ cwd: project() }), "/v1/run", {
			recipe: "greet",
			params: { name: "Ada" },
			llm: { baseUrl: "http://127.0.0.1:1/v1", model: "tiny", apiKeyEnv: "PER_CALL_KEY" },
		})
		expect(res.status).toBe(400)
		const body = (await res.json()) as { error: { code: string; message: string } }
		expect(body.error.code).toBe("bad-request")
		expect(body.error.message).toContain("PER_CALL_KEY")
	})

	it("reads the user's config only when not isolated", async () => {
		const model = await fakeModel("From the user config.")
		writeFileSync(
			join(process.env.BAKA_HOME as string, "config.json"),
			JSON.stringify({ worker: { baseUrl: model.baseUrl, model: "m", apiKey: "k" } }),
		)
		const body = { recipe: "greet", params: { name: "Ada" } }
		const open = await post(createEngineApp({ cwd: project() }), "/v1/run", body)
		expect(open.status).toBe(200)
		expect(model.requests).toHaveLength(1)

		const isolated = await post(createEngineApp({ cwd: project(), isolated: true }), "/v1/run", body)
		expect(isolated.status).toBe(400)
		expect(model.requests).toHaveLength(1)
	})

	it("sees the user's packs only when not isolated", async () => {
		writePack(join(process.env.BAKA_HOME as string, "packs"), "mine", "own-recipe")
		const names = async (isolated: boolean) =>
			(
				(await (await createEngineApp({ cwd: project(), isolated }).request("/v1/packs")).json()) as {
					packs: Array<{ name: string }>
				}
			).packs
				.map((p) => p.name)
				.sort()
		expect(await names(false)).toEqual(["hello", "mine"])
		expect(await names(true)).toEqual(["hello"])
	})

	it("ignores the user's slot cache when isolated", async () => {
		const cwd = project()
		const app = createEngineApp({ cwd })
		await post(app, "/v1/fill", { recipe: "greet", slot: "blurb", value: "cached", params: { name: "Ada" } })
		const second = project()
		// A user-level cache entry for the same slot: copy the project's cache into the user's directory.
		const { cpSync } = await import("node:fs")
		cpSync(join(cwd, ".baka", "slots"), join(process.env.BAKA_HOME as string, "slots"), { recursive: true })
		const body = { recipe: "greet", params: { name: "Ada" } }
		expect((await post(createEngineApp({ cwd: second }), "/v1/run", body)).status).toBe(200)
		expect((await post(createEngineApp({ cwd: project(), isolated: true }), "/v1/run", body)).status).toBe(400)
	})
})
