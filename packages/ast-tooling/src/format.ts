import { spawnSync } from "node:child_process"
import { delimiter, join } from "node:path"
import type { ChangesetEntry, ModuleAction } from "@repo/protocol"
import { ActionError } from "./errors.js"

type FormatSpec = NonNullable<ModuleAction["format"]>

const FORMAT_TIMEOUT_MS = 120_000

/**
 * Run an action's declared formatter over the files the run created or
 * updated, from the project root. The command resolves through `PATH` with the
 * project's `node_modules/.bin` first, so a formatter installed in the project
 * is found. `{files}` in `args` expands to one argument per file (relative
 * paths); without it the files are appended. Returns the paths it ran over
 * (none: the command is not run). A formatter that cannot start, times out, or
 * exits non-zero fails the run with `format-failed`, and the caller's rollback
 * undoes the run.
 */
export function runFormatter(root: string, spec: FormatSpec, changeset: readonly ChangesetEntry[]): string[] {
	const files = changeset.filter((e) => e.op === "create" || e.op === "update").map((e) => e.path)
	if (files.length === 0) return []
	const args = spec.args.includes("{files}")
		? spec.args.flatMap((a) => (a === "{files}" ? files : [a]))
		: [...spec.args, ...files]
	const result = spawnSync(spec.command, args, {
		cwd: root,
		encoding: "utf-8",
		timeout: FORMAT_TIMEOUT_MS,
		env: { ...process.env, PATH: [join(root, "node_modules", ".bin"), process.env.PATH ?? ""].join(delimiter) },
	})
	const shown = `${spec.command} ${args.slice(0, 3).join(" ")}${args.length > 3 ? " ..." : ""}`
	if (result.error) {
		throw new ActionError("format-failed", `the formatter \`${shown}\` could not run: ${result.error.message}`)
	}
	if (result.status !== 0) {
		const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n").slice(-8).join("\n")
		throw new ActionError(
			"format-failed",
			`the formatter \`${shown}\` exited ${result.status}${detail ? `:\n${detail}` : ""}`,
		)
	}
	return files
}
