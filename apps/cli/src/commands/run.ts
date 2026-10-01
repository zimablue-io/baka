import { readFileSync } from "node:fs"
import { engineRequest } from "@baka/engine"
import { BAKA_EXIT_CODE } from "@repo/protocol"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

export function parseModuleAction(target: string): { module: string; action: string } {
	const idx = target.indexOf("/")
	if (idx <= 0 || idx === target.length - 1) {
		die(BAKA_EXIT_CODE.USER_ERROR, `expected <module>/<action>, got "${target}"`)
	}
	return { module: target.slice(0, idx), action: target.slice(idx + 1) }
}

export function parseParamFlags(raw: string[] | undefined, paramsJson?: string): Record<string, unknown> {
	let params: Record<string, unknown> = {}
	if (paramsJson) {
		try {
			const parsed = JSON.parse(paramsJson) as unknown
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				params = parsed as Record<string, unknown>
			} else {
				die(BAKA_EXIT_CODE.USER_ERROR, "--params must be a JSON object")
			}
		} catch (err) {
			die(BAKA_EXIT_CODE.USER_ERROR, `--params is not JSON: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
	if (!raw) return params
	for (let i = 0; i < raw.length; i++) {
		const tok = raw[i]
		if (!tok?.startsWith("--")) continue
		const key = tok.slice(2)
		if (
			key === "json" ||
			key === "refill" ||
			key === "params" ||
			key === "slot" ||
			key === "file" ||
			key === "value" ||
			key === "cwd" ||
			key === "port" ||
			key === "help" ||
			key === "version"
		) {
			if (key === "cwd" || key === "params" || key === "slot" || key === "file" || key === "value" || key === "port") {
				i++
			}
			continue
		}
		const next = raw[i + 1]
		if (!next || next.startsWith("--")) {
			params[key] = true
		} else {
			params[key] = next
			i++
		}
	}
	return params
}

function printJson(value: unknown): void {
	console.log(JSON.stringify(value, null, 2))
}

export async function runRunCommand(
	target: string,
	opts: { cwd: string; json?: boolean; refill?: boolean; params?: string; extra?: string[] },
): Promise<void> {
	const { module, action } = parseModuleAction(target)
	const params = parseParamFlags(opts.extra, opts.params)
	const { status, json } = await engineRequest(opts.cwd, "/v1/run", {
		method: "POST",
		body: { module, action, params, refill: opts.refill },
	})
	const body = json as { ok?: boolean; error?: string; written?: string[]; slots?: unknown[] }
	if (opts.json) {
		printJson(json)
	} else if (body.ok) {
		console.log(`run ${module}/${action}: wrote ${(body.written ?? []).join(", ") || "(nothing new)"}`)
	} else {
		process.stderr.write(`baka: ${body.error ?? "run failed"}\n`)
	}
	if (status >= 400 || body.ok === false) {
		process.exit(BAKA_EXIT_CODE.ENGINE_ERROR)
	}
}

export async function runSlotsCommand(target: string, opts: { cwd: string; json?: boolean }): Promise<void> {
	const { module, action } = parseModuleAction(target)
	const { status, json } = await engineRequest(
		opts.cwd,
		`/v1/slots?module=${encodeURIComponent(module)}&action=${encodeURIComponent(action)}`,
	)
	if (opts.json) printJson(json)
	else {
		const body = json as { slots?: Array<{ id: string; kind: string; hint: string }>; error?: string }
		if (body.error) die(BAKA_EXIT_CODE.USER_ERROR, body.error)
		for (const slot of body.slots ?? []) {
			console.log(`${slot.id}\t${slot.kind}\t${slot.hint.replace(/\s+/g, " ").slice(0, 80)}`)
		}
	}
	if (status >= 400) process.exit(BAKA_EXIT_CODE.USER_ERROR)
}

export async function runInspectCommand(target: string, opts: { cwd: string; json?: boolean }): Promise<void> {
	const { module, action } = parseModuleAction(target)
	const { status, json } = await engineRequest(
		opts.cwd,
		`/v1/preview?module=${encodeURIComponent(module)}&action=${encodeURIComponent(action)}`,
	)
	const body = json as {
		error?: string
		description?: string
		params?: Array<{ name: string; type: string; required: boolean; description: string }>
		files?: Array<{ rel: string; source: string }>
		slots?: Array<{ id: string; kind: string; hint: string }>
	}
	if (opts.json) printJson(json)
	else if (body.error) die(BAKA_EXIT_CODE.USER_ERROR, body.error)
	else {
		console.log(`${module}/${action}`)
		if (body.description) console.log(body.description)
		for (const p of body.params ?? []) {
			console.log(`  param ${p.name}${p.required ? "" : "?"} (${p.type}): ${p.description}`)
		}
		for (const slot of body.slots ?? []) {
			console.log(`  slot ${slot.id} (${slot.kind}): ${slot.hint.replace(/\s+/g, " ").slice(0, 80)}`)
		}
		for (const file of body.files ?? []) {
			console.log(`--- ${file.rel}`)
			console.log(file.source)
		}
	}
	if (status >= 400) process.exit(BAKA_EXIT_CODE.USER_ERROR)
}

export async function runFillCommand(
	target: string,
	opts: {
		cwd: string
		json?: boolean
		slot?: string
		file?: string
		value?: string
		params?: string
		extra?: string[]
	},
): Promise<void> {
	const { module, action } = parseModuleAction(target)
	if (!opts.slot) die(BAKA_EXIT_CODE.USER_ERROR, "--slot <id> is required")
	let value: unknown = opts.value
	if (opts.file) {
		value = readFileSync(opts.file, "utf-8")
	}
	if (value === undefined) die(BAKA_EXIT_CODE.USER_ERROR, "--value or --file is required")
	const params = parseParamFlags(opts.extra, opts.params)
	const { status, json } = await engineRequest(opts.cwd, "/v1/fill", {
		method: "POST",
		body: { module, action, slot: opts.slot, value, params },
	})
	if (opts.json) printJson(json)
	else {
		const body = json as { ok?: boolean; error?: string; cachePath?: string }
		if (body.ok) console.log(`filled ${opts.slot} → ${body.cachePath}`)
		else process.stderr.write(`baka: ${body.error ?? "fill failed"}\n`)
	}
	if (status >= 400) process.exit(BAKA_EXIT_CODE.ENGINE_ERROR)
}

export async function runListModulesCommand(opts: { cwd: string; json?: boolean }): Promise<void> {
	const { status, json } = await engineRequest(opts.cwd, "/v1/modules")
	const body = json as {
		modules?: Array<{ name: string; version: string; description: string; actions: unknown[] }>
		diagnostics?: Array<{ severity: string; message: string }>
		error?: string
	}
	if (status >= 400) {
		die(BAKA_EXIT_CODE.ENGINE_ERROR, body.error ?? "list-modules failed")
	}
	const mapped = {
		modules: (body.modules ?? []).map((m) => ({
			name: m.name,
			version: m.version,
			description: m.description,
			actions: Array.isArray(m.actions) ? m.actions.length : 0,
			uri: `baka://module/${m.name}/manifest`,
		})),
		diagnostics: body.diagnostics ?? [],
	}
	if (opts.json) {
		printJson(mapped)
		return
	}
	console.log(`\nFound ${mapped.modules.length} module(s):\n`)
	if (mapped.modules.length === 0) {
		for (const d of mapped.diagnostics) console.log(`  (${d.severity}) ${d.message}`)
	} else {
		mapped.modules.forEach((m) => {
			console.log(`  - ${m.name.padEnd(20)} v${m.version}`)
			console.log(`    Actions: ${m.actions}`)
		})
	}
	console.log("")
}

export async function runServeCommand(opts: { cwd: string; port: number }): Promise<void> {
	const { serve } = await import("@hono/node-server")
	const { createEngineApp } = await import("@baka/engine")
	const app = createEngineApp({ cwd: opts.cwd })
	serve({ fetch: app.fetch, port: opts.port, hostname: "127.0.0.1" }, (info) => {
		process.stderr.write(`baka serve: http://127.0.0.1:${info.port}\n`)
	})
}
