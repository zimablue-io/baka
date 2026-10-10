import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { BAKA_EXIT_CODE, type PackManifest, PackManifestSchema } from "@repo/protocol"
import { createJiti } from "jiti"
import { die } from "../die"

/** The file a repository ships so a host (Moralo) can use it. Same name for every kind of module. */
const MORALO_MODULE_FILE = "moralo.module.json"

interface PackFound {
	dir: string
	manifest: PackManifest
}

interface PackageJson {
	name?: string
	version?: string
	description?: string
	license?: string
	repository?: string | { url?: string }
}

interface ModuleDocument extends Record<string, unknown> {
	id?: string
}

function readJson<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T
	} catch (err) {
		die(BAKA_EXIT_CODE.BAD_INPUT, `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
	}
}

/** The packs of a repository: the directory itself when it holds `manifest.ts`, else each subdirectory that does. */
function findPacks(root: string): PackFound[] {
	const candidates = existsSync(join(root, "manifest.ts"))
		? [root]
		: readdirSync(root, { withFileTypes: true })
				.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
				.map((e) => join(root, e.name))
				.filter((dir) => existsSync(join(dir, "manifest.ts")))
				.sort()
	if (candidates.length === 0) {
		die(BAKA_EXIT_CODE.BAD_INPUT, `no pack found in ${root}`, {
			code: "pack-not-found",
			hint: "A pack is a directory with a manifest.ts. Run this in the pack, or in a repository whose subdirectories are packs.",
		})
	}
	return candidates.map((dir) => {
		const mod = createJiti(dir)(join(dir, "manifest.ts")) as { Manifest?: unknown }
		const parsed = PackManifestSchema.safeParse(mod.Manifest)
		if (!parsed.success) {
			const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(manifest)"}: ${i.message}`).join("; ")
			die(BAKA_EXIT_CODE.BAD_INPUT, `${join(dir, "manifest.ts")} is not a valid pack manifest: ${issues}`, {
				code: "pack-invalid",
				hint: "Run `baka pack validate <name>` for the full list.",
			})
		}
		return { dir, manifest: parsed.data }
	})
}

/** `owner/name` from a git remote or repository URL of GitHub shape, else undefined. */
function ownerAndName(url: string | undefined): { id: string; source: string } | undefined {
	const match = url?.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
	if (!match) return undefined
	return { id: `${match[1]}/${match[2]}`, source: `https://github.com/${match[1]}/${match[2]}` }
}

function gitRemote(root: string): string | undefined {
	try {
		return execFileSync("git", ["-C", root, "remote", "get-url", "origin"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim()
	} catch {
		return undefined
	}
}

/**
 * The module document for a repository of packs. Identity the author owns (`id`, `name`, `summary`,
 * `publisher`, `license`, `source`, `docs`) is kept from an existing file; everything that follows
 * from the packs (version, kinds, transports, surfaces, permissions) is generated.
 */
function buildPackModule(root: string, idOverride?: string): ModuleDocument {
	const packs = findPacks(root)
	const pkg = readJson<PackageJson>(join(root, "package.json"))
	const existing = readJson<ModuleDocument>(join(root, MORALO_MODULE_FILE)) ?? {}
	const repoUrl = typeof pkg?.repository === "string" ? pkg.repository : pkg?.repository?.url
	const fromGit = ownerAndName(repoUrl) ?? ownerAndName(gitRemote(root))

	const id =
		idOverride ??
		(typeof existing.id === "string" ? existing.id : undefined) ??
		(pkg?.name?.includes("/") ? pkg.name.replace(/^@/, "") : undefined) ??
		fromGit?.id
	if (!id || !/^[^/\s]+\/[^/\s]+$/.test(id)) {
		die(BAKA_EXIT_CODE.BAD_INPUT, "cannot tell the module id (owner/name)", {
			code: "bad-request",
			hint: 'Pass --id owner/name, or set "name" (@owner/name) or "repository" in package.json.',
		})
	}

	const single = packs.length === 1 ? packs[0]?.manifest : undefined
	const version = single?.version ?? pkg?.version
	if (!version) {
		die(BAKA_EXIT_CODE.BAD_INPUT, "cannot tell the module version", {
			code: "bad-request",
			hint: "A repository of several packs takes its version from package.json.",
		})
	}

	const surfaces = packs.flatMap(({ manifest }) =>
		manifest.recipes.map((recipe) => ({
			surface: "nodeKind",
			id: `${manifest.name}.${recipe.id}`,
			label: recipe.id,
			ports: { in: ["params", "slots"], out: ["receipt"] },
			transport: "cli",
			run: ["--packs-dir", "{moduleDir}", "run", `${manifest.name}/${recipe.id}`, "--json"],
			result: "baka.receipt/1",
			reproducible: true,
		})),
	)

	const generated: ModuleDocument = {
		version,
		requires: { moralo: ">=0 <1", baka: ">=1 <2" },
		kinds: ["pack"],
		transports: [
			{
				type: "cli",
				command: "baka",
				json: true,
				handshake: ["version", "--json"],
				schemas: ["schema", "{id}"],
				env: { BAKA_ISOLATED: "1" },
			},
		],
		surfaces,
		permissions: [
			{ read: "project.files", why: "to see which files the recipes would create, change or leave alone" },
			{ write: "project.files", why: "a recipe writes the files it generates", via: "proposal" },
		],
		scope: { install: "org", enable: "project" },
		runsOn: ["machine"],
	}

	const authored: ModuleDocument = {
		manifest: 0,
		id,
		name: pkg?.name ?? single?.name ?? basename(id),
		summary:
			single?.description ??
			pkg?.description ??
			`${packs.length} Baka packs: ${packs.map((p) => p.manifest.name).join(", ")}`,
		publisher: { name: id.split("/")[0] },
		license: pkg?.license ?? "UNLICENSED",
		...(fromGit ? { source: fromGit.source } : {}),
	}
	const keep = Object.fromEntries(
		["id", "name", "summary", "publisher", "license", "source", "docs"]
			.filter((key) => existing[key] !== undefined)
			.map((key) => [key, existing[key]]),
	)
	const document = { ...authored, ...keep, ...generated }
	if (idOverride) document.id = idOverride
	return orderKeys(document)
}

const KEY_ORDER = [
	"manifest",
	"id",
	"name",
	"version",
	"summary",
	"publisher",
	"license",
	"source",
	"docs",
	"requires",
	"kinds",
	"transports",
	"surfaces",
	"permissions",
	"scope",
	"runsOn",
]

function orderKeys(document: ModuleDocument): ModuleDocument {
	const ordered: ModuleDocument = {}
	for (const key of KEY_ORDER) if (document[key] !== undefined) ordered[key] = document[key]
	for (const key of Object.keys(document)) if (!(key in ordered)) ordered[key] = document[key]
	return ordered
}

function render(document: ModuleDocument): string {
	return `${JSON.stringify(document, null, "\t")}\n`
}

/**
 * `baka pack manifest [dir]`: print the `moralo.module.json` for a repository of packs, write it with
 * `--write`, or fail with `--check` when the file on disk no longer matches the packs.
 */
export function runPackManifest(
	dir: string | undefined,
	opts: { cwd: string; id?: string; write?: boolean; check?: boolean; json?: boolean },
): void {
	if (opts.write && opts.check) die(BAKA_EXIT_CODE.BAD_INPUT, "--write and --check cannot be used together")
	const root = resolve(opts.cwd, dir ?? ".")
	if (!existsSync(root)) die(BAKA_EXIT_CODE.BAD_INPUT, `not a directory: ${root}`)
	const rendered = render(buildPackModule(root, opts.id))
	const file = join(root, MORALO_MODULE_FILE)

	if (opts.check) {
		const onDisk = existsSync(file) ? readFileSync(file, "utf-8") : undefined
		if (onDisk === undefined) {
			die(BAKA_EXIT_CODE.FAILED, `${file} does not exist`, {
				code: "manifest-missing",
				hint: "Run `baka pack manifest --write`.",
			})
		}
		if (onDisk !== rendered) {
			die(BAKA_EXIT_CODE.FAILED, `${file} no longer matches the packs`, {
				code: "manifest-stale",
				hint: "Run `baka pack manifest --write` and commit the result.",
			})
		}
		console.log(opts.json ? JSON.stringify({ ok: true, file }) : `${file} is up to date`)
		return
	}
	if (opts.write) {
		writeFileSync(file, rendered)
		console.log(opts.json ? JSON.stringify({ ok: true, file }) : `wrote ${file}`)
		return
	}
	process.stdout.write(rendered)
}
