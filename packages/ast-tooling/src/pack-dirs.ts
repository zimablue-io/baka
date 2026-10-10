import { existsSync, readFileSync, statSync } from "node:fs"
import { delimiter, isAbsolute, join, resolve } from "node:path"
import { BAKA_PROJECT_PATHS } from "@repo/protocol"

/** Env var listing pack directories, separated like PATH (`:` or `;`). See `packDirsFromEnv`. */
export const PACK_DIRS_ENV = "BAKA_PACK_DIRS"

/** The key of `.baka/settings.json` that lists a project's pack directories. */
export const PACK_DIRS_SETTING = "packDirs"

/**
 * A pack-directory setting that cannot be honoured: a malformed settings
 * file, a wrongly shaped `packDirs`, or an entry that is not a directory.
 * The message names the file, the entry, and what to change, so callers print
 * it as it is.
 */
export class PackDirsError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "PackDirsError"
	}
}

/**
 * The pack directories named by `BAKA_PACK_DIRS` (highest precedence
 * first), resolved against the current directory; undefined when the variable
 * is unset or empty. Passing them as `PackRegistryOptions.packDirs` makes
 * a catalog usable from any project directory, without symlinks and without
 * the catalog ever being a place output is written to.
 */
export function packDirsFromEnv(env: NodeJS.ProcessEnv): string[] | undefined {
	const dirs = (env[PACK_DIRS_ENV] ?? "")
		.split(delimiter)
		.filter((d) => d.trim() !== "")
		.map((d) => resolve(d))
	return dirs.length > 0 ? dirs : undefined
}

/**
 * The `packDirs` list of `<root>/.baka/settings.json` (highest precedence
 * first), each entry resolved against the project root `root`; undefined when
 * the file does not exist, has no `packDirs`, or lists none. Unlike the
 * registry and package lists in the same file, a setting that cannot be
 * honoured is an error, never silently the default discovery: a malformed
 * file, a `packDirs` that is not an array of non-empty strings, and an entry
 * that is not an existing directory all throw `PackDirsError`.
 */
export function packDirsFromSettings(root: string): string[] | undefined {
	const file = join(root, BAKA_PROJECT_PATHS.ROOT, "settings.json")
	if (!existsSync(file)) return undefined
	let raw: unknown
	try {
		raw = JSON.parse(readFileSync(file, "utf-8")) as unknown
	} catch (err) {
		throw new PackDirsError(
			`${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}); fix the file or remove it`,
		)
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
	const listed = (raw as Record<string, unknown>)[PACK_DIRS_SETTING]
	if (listed === undefined) return undefined
	if (!Array.isArray(listed)) {
		throw new PackDirsError(`${file}: ${PACK_DIRS_SETTING} must be an array of directory paths`)
	}
	const dirs: string[] = []
	listed.forEach((entry: unknown, index) => {
		const where = `${file}: ${PACK_DIRS_SETTING}[${index}]`
		if (typeof entry !== "string" || entry.trim() === "") {
			throw new PackDirsError(`${where} must be a non-empty string`)
		}
		const dir = isAbsolute(entry) ? entry : resolve(root, entry)
		if (!existsSync(dir)) {
			throw new PackDirsError(
				`${where} is "${entry}", which resolves to ${dir} and does not exist; create the directory, fix the entry, or remove it from ${PACK_DIRS_SETTING}`,
			)
		}
		if (!statSync(dir).isDirectory()) {
			throw new PackDirsError(
				`${where} is "${entry}", which resolves to ${dir} and is not a directory; fix the entry or remove it from ${PACK_DIRS_SETTING}`,
			)
		}
		dirs.push(dir)
	})
	return dirs.length > 0 ? dirs : undefined
}

/**
 * Where a project's packs come from, highest precedence first: an explicit
 * list (`--packs-dir`), then `BAKA_PACK_DIRS`, then the project's
 * `.baka/settings.json` `packDirs`; undefined means the default discovery
 * (the project's `packs/` and `.baka/packs`, then the user marketplace).
 * A lower source is not read when a higher one decides. Whichever source
 * decides, only its directories are searched.
 */
export function resolvePackDirs(opts: {
	root: string
	flag?: readonly string[]
	env?: NodeJS.ProcessEnv
}): string[] | undefined {
	if (opts.flag && opts.flag.length > 0) return opts.flag.map((dir) => resolve(dir))
	const fromEnv = packDirsFromEnv(opts.env ?? process.env)
	if (fromEnv) return fromEnv
	return packDirsFromSettings(opts.root)
}
