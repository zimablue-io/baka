import { readFileSync } from "node:fs"
import { engineRequest } from "@baka/engine"
import { createLock, PackRegistry, writeLockfile } from "@repo/ast-tooling"
import { BAKA_EXIT_CODE, BAKA_LOCKFILE_NAME, exitCodeForRule, type OpenSlot } from "@repo/protocol"
import { type CallOptions, dieOnApiError, engineInit, registryOptions } from "../call"
import { die } from "../die"

/** `<recipe>` or `<pack>/<recipe>`. A bare recipe name is resolved by the engine, which refuses an ambiguous one. */
export function parseTarget(target: string): { pack?: string; recipe: string } {
	const idx = target.indexOf("/")
	if (idx === -1) return { recipe: target }
	if (idx === 0 || idx === target.length - 1) {
		die(BAKA_EXIT_CODE.BAD_INPUT, `expected <recipe> or <pack>/<recipe>, got "${target}"`)
	}
	return { pack: target.slice(0, idx), recipe: target.slice(idx + 1) }
}

function targetLabel(target: { pack?: string; recipe: string }): string {
	return target.pack ? `${target.pack}/${target.recipe}` : target.recipe
}

/** The query string that names a recipe to the engine's GET routes. */
function targetQuery(target: { pack?: string; recipe: string }): string {
	const pack = target.pack ? `pack=${encodeURIComponent(target.pack)}&` : ""
	return `${pack}recipe=${encodeURIComponent(target.recipe)}`
}

export function parseParamFlags(raw: string[] | undefined, paramsJson?: string): Record<string, unknown> {
	let params: Record<string, unknown> = {}
	if (paramsJson) {
		try {
			const parsed = JSON.parse(paramsJson) as unknown
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				params = parsed as Record<string, unknown>
			} else {
				die(BAKA_EXIT_CODE.BAD_INPUT, "--params must be a JSON object")
			}
		} catch (err) {
			die(BAKA_EXIT_CODE.BAD_INPUT, `--params is not JSON: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
	if (!raw) return params
	for (let i = 0; i < raw.length; i++) {
		const tok = raw[i]
		if (!tok?.startsWith("--")) continue
		const key = tok.slice(2)
		if (
			key === "json" ||
			key === "dry-run" ||
			key === "slot-mode" ||
			key === "slot-records" ||
			key === "on-existing" ||
			key === "include-content" ||
			key === "no-validate" ||
			key === "format" ||
			key === "params" ||
			key === "slot" ||
			key === "slots-file" ||
			key === "isolated" ||
			key === "addon" ||
			key === "llm-base-url" ||
			key === "llm-model" ||
			key === "llm-api-key" ||
			key === "llm-api-key-env" ||
			key === "file" ||
			key === "value" ||
			key === "cwd" ||
			key === "packs-dir" ||
			key === "port" ||
			key === "help" ||
			key === "version"
		) {
			if (
				key === "cwd" ||
				key === "packs-dir" ||
				key === "params" ||
				key === "slot" ||
				key === "slots-file" ||
				key === "addon" ||
				key === "llm-base-url" ||
				key === "llm-model" ||
				key === "llm-api-key" ||
				key === "llm-api-key-env" ||
				key === "file" ||
				key === "value" ||
				key === "port" ||
				key === "slot-mode" ||
				key === "slot-records" ||
				key === "on-existing"
			) {
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
	opts: CallOptions & {
		json?: boolean
		dryRun?: boolean
		includeContent?: boolean
		/** `false` skips the validators (`--no-validate`); anything else validates, as `runRecipe` does. */
		validate?: boolean
		/** Run the formatter the recipe declares over the files the run wrote (`--format`). */
		format?: boolean
		slotMode?: string
		slotRecords?: string
		/** `--slot id=value`, repeatable. */
		slot?: string[]
		/** `--slots-file`: a JSON object of slot id to value. */
		slotsFile?: string
		onExisting?: string
		params?: string
		extra?: string[]
	},
): Promise<void> {
	const named = parseTarget(target)
	const params = parseParamFlags(opts.extra, opts.params)
	const slots = parseSlotsFlags(opts.slotMode, opts.slotRecords, parseSlotValues(opts.slot, opts.slotsFile))
	if (opts.onExisting !== undefined && !["skip", "overwrite", "fail"].includes(opts.onExisting)) {
		die(BAKA_EXIT_CODE.BAD_INPUT, `--on-existing must be skip, overwrite, or fail; got "${opts.onExisting}"`)
	}
	const { status, json } = await engineRequest(opts.cwd, "/v1/run", {
		...engineInit(opts),
		method: "POST",
		body: {
			...named,
			params,
			slots,
			onExisting: opts.onExisting,
			dryRun: opts.dryRun,
			includeContent: opts.includeContent,
			validate: opts.validate === false ? false : undefined,
			format: opts.format ? true : undefined,
		},
	})
	dieOnApiError(status, json)
	const body = json as RunBody
	if (opts.json) {
		printJson(json)
	} else {
		printRunSummary(targetLabel(named), body)
	}
	reportOpenSlots(body.openSlots)
	if (status >= 400 || body.ok === false) {
		const firstError = body.diagnostics?.find((d) => d.severity === "error")
		process.exit(exitCodeForRule(firstError?.rule))
	}
}

/**
 * `--slot id=value` (repeatable) and `--slots-file <file>` (a JSON object of id to value). The
 * flags win over the file. These are the fills a caller supplies for this one call: they need no
 * model, and are never written to the slot cache.
 */
export function parseSlotValues(
	assignments: string[] | undefined,
	file: string | undefined,
): Record<string, unknown> | undefined {
	if (!assignments?.length && file === undefined) return undefined
	const values: Record<string, unknown> = {}
	if (file !== undefined) {
		let parsed: unknown
		try {
			parsed = JSON.parse(readFileSync(file, "utf-8"))
		} catch (err) {
			die(BAKA_EXIT_CODE.BAD_INPUT, `--slots-file ${file}: ${err instanceof Error ? err.message : String(err)}`)
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			die(BAKA_EXIT_CODE.BAD_INPUT, `--slots-file ${file} must be a JSON object of slot id to value`)
		}
		Object.assign(values, parsed)
	}
	for (const assignment of assignments ?? []) {
		const eq = assignment.indexOf("=")
		if (eq <= 0) die(BAKA_EXIT_CODE.BAD_INPUT, `--slot expects <id>=<value>, got "${assignment}"`)
		values[assignment.slice(0, eq)] = assignment.slice(eq + 1)
	}
	return values
}

/**
 * `--slot-mode live|record|replay`, `--slot-records <file>` and the values a caller supplies. The
 * file holds a JSON array of slot records, or a receipt (`baka run --json` output) whose `slots`
 * are used, so a recorded run can be replayed by passing its output back.
 */
function parseSlotsFlags(
	mode: string | undefined,
	recordsFile: string | undefined,
	values: Record<string, unknown> | undefined,
): { mode: string; records?: unknown[]; values?: Record<string, unknown> } | undefined {
	if (mode === undefined && recordsFile === undefined && values === undefined) return undefined
	const resolved = mode ?? (recordsFile ? "replay" : "live")
	if (!["live", "record", "replay"].includes(resolved)) {
		die(BAKA_EXIT_CODE.BAD_INPUT, `--slot-mode must be live, record, or replay; got "${resolved}"`)
	}
	const supplied = values ? { values } : {}
	if (!recordsFile) return { mode: resolved, ...supplied }
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(recordsFile, "utf-8"))
	} catch (err) {
		die(BAKA_EXIT_CODE.BAD_INPUT, `--slot-records ${recordsFile}: ${err instanceof Error ? err.message : String(err)}`)
	}
	const records = Array.isArray(parsed) ? parsed : (parsed as { slots?: unknown } | null)?.slots
	if (!Array.isArray(records)) {
		die(
			BAKA_EXIT_CODE.BAD_INPUT,
			`--slot-records ${recordsFile} must be a JSON array of slot records or a receipt with "slots"`,
		)
	}
	return { mode: resolved, records, ...supplied }
}

interface RunBody {
	ok?: boolean
	dryRun?: boolean
	outputTreeHash?: string
	changeset?: Array<{ path: string; op: string; reason?: string }>
	diagnostics?: Array<{ severity: string; rule: string; message: string; validator?: string }>
	openSlots?: OpenSlot[]
}

function printRunSummary(target: string, body: RunBody): void {
	for (const d of body.diagnostics ?? []) {
		process.stderr.write(`baka: ${d.severity} [${d.rule}] ${d.message}${d.validator ? ` (${d.validator})` : ""}\n`)
	}
	if (!body.ok) return
	const lines = (body.changeset ?? []).map((e) => `  ${e.op.padEnd(9)} ${e.path}${e.reason ? ` (${e.reason})` : ""}`)
	console.log(`${body.dryRun ? "dry run " : "run "}${target}: ${lines.length === 0 ? "(no files)" : ""}`)
	for (const line of lines) console.log(line)
	console.log(`  tree      ${body.outputTreeHash}`)
}

/** What a caller must supply when a run stopped on slots that have no value and no model: the flag, per slot. */
function reportOpenSlots(openSlots: OpenSlot[] | undefined): void {
	if (!openSlots?.length) return
	process.stderr.write("baka: these slots need a value; pass each one and run again:\n")
	for (const slot of openSlots) {
		process.stderr.write(
			`  --slot ${slot.id}=<value>   (${slot.kind}) ${slot.hint.replace(/\s+/g, " ").slice(0, 80)}\n`,
		)
	}
	process.stderr.write("  or give a model: --llm-base-url <url> --llm-model <name> [--llm-api-key-env <VAR>]\n")
}

export async function runSlotsCommand(target: string, opts: CallOptions & { json?: boolean }): Promise<void> {
	const named = parseTarget(target)
	const { status, json } = await engineRequest(opts.cwd, `/v1/slots?${targetQuery(named)}`, engineInit(opts))
	dieOnApiError(status, json)
	if (opts.json) printJson(json)
	else {
		const body = json as { slots?: Array<{ id: string; kind: string; hint: string }> }
		for (const slot of body.slots ?? []) {
			console.log(`${slot.id}\t${slot.kind}\t${slot.hint.replace(/\s+/g, " ").slice(0, 80)}`)
		}
	}
}

export async function runInspectCommand(target: string, opts: CallOptions & { json?: boolean }): Promise<void> {
	const named = parseTarget(target)
	const { status, json } = await engineRequest(opts.cwd, `/v1/preview?${targetQuery(named)}`, engineInit(opts))
	dieOnApiError(status, json)
	const body = json as {
		pack?: string
		description?: string
		params?: Array<{ name: string; type: string; required: boolean; description: string }>
		files?: Array<{ rel: string; source: string }>
		slots?: Array<{ id: string; kind: string; hint: string }>
	}
	if (opts.json) {
		printJson(json)
		return
	}
	console.log(`${body.pack ?? named.pack}/${named.recipe}`)
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

export async function runFillCommand(
	target: string,
	opts: CallOptions & {
		json?: boolean
		slot?: string
		file?: string
		value?: string
		params?: string
		extra?: string[]
	},
): Promise<void> {
	const named = parseTarget(target)
	if (!opts.slot) die(BAKA_EXIT_CODE.BAD_INPUT, "--slot <id> is required")
	let value: unknown = opts.value
	if (opts.file) {
		value = readFileSync(opts.file, "utf-8")
	}
	if (value === undefined) die(BAKA_EXIT_CODE.BAD_INPUT, "--value or --file is required")
	const params = parseParamFlags(opts.extra, opts.params)
	const { status, json } = await engineRequest(opts.cwd, "/v1/fill", {
		...engineInit(opts),
		method: "POST",
		body: { ...named, slot: opts.slot, value, params },
	})
	dieOnApiError(status, json)
	if (opts.json) printJson(json)
	else console.log(`filled ${opts.slot} → ${(json as { cachePath?: string }).cachePath}`)
}

export async function runListPacksCommand(opts: CallOptions & { json?: boolean }): Promise<void> {
	const { status, json } = await engineRequest(opts.cwd, "/v1/packs", engineInit(opts))
	dieOnApiError(status, json)
	const body = json as {
		packs?: Array<{ name: string; version: string; description: string; recipes: unknown[] }>
		diagnostics?: Array<{ severity: string; message: string }>
	}
	if (opts.json) {
		// The catalog verbatim: the same document as GET /v1/packs, the baka://packs
		// MCP resource, and describePacks() in @baka/core (params, JSON Schemas, resultSchema).
		printJson(json)
		return
	}
	const packs = body.packs ?? []
	console.log(`\nFound ${packs.length} pack(s):\n`)
	if (packs.length === 0) {
		for (const d of body.diagnostics ?? []) console.log(`  (${d.severity}) ${d.message}`)
	} else {
		for (const m of packs) {
			console.log(`  - ${m.name.padEnd(20)} v${m.version}`)
			console.log(`    Recipes: ${m.recipes.length}`)
		}
	}
	console.log("")
}

/**
 * `baka lock [packs...]`: pin every discovered pack (or just the named
 * ones) to its current version and content hash in `<cwd>/baka.lock.json`.
 * From then on `baka run` refuses a pack that no longer matches.
 */
export function runLockCommand(opts: CallOptions & { json?: boolean; packs?: string[] }): void {
	const registry = new PackRegistry(opts.cwd, registryOptions(opts))
	const { packs } = registry.discover(false)
	for (const name of opts.packs ?? []) {
		if (!packs.some((m) => m.name === name)) die(BAKA_EXIT_CODE.BAD_INPUT, `pack "${name}" not found`)
	}
	const lock = createLock(registry, opts.packs?.length ? opts.packs : undefined)
	const path = writeLockfile(opts.cwd, lock)
	if (opts.json) {
		printJson({ path, lock })
		return
	}
	const names = Object.keys(lock.packs)
	console.log(`locked ${names.length} pack(s) in ${BAKA_LOCKFILE_NAME}`)
	for (const name of names) console.log(`  ${name}@${lock.packs[name]?.version}`)
}

export async function runServeCommand(opts: {
	cwd: string
	packDirs?: string[]
	port: number
	host?: string
	token?: string
	allowRoots?: string[]
	allowOrigins?: string[]
}): Promise<void> {
	const { resolveServeConfig, serveEngine } = await import("@baka/engine")
	let config: ReturnType<typeof resolveServeConfig>
	try {
		config = resolveServeConfig(
			{
				port: opts.port,
				host: opts.host,
				token: opts.token,
				allowRoots: opts.allowRoots,
				allowOrigins: opts.allowOrigins,
				packDirs: opts.packDirs,
			},
			process.env,
			opts.cwd,
		)
	} catch (err) {
		die(BAKA_EXIT_CODE.BAD_INPUT, err instanceof Error ? err.message : String(err))
	}
	const running = await serveEngine(opts.cwd, config)
	process.stderr.write(`baka serve: ${running.url}${config.token ? " (bearer token required)" : ""}\n`)
}
