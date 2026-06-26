#!/usr/bin/env node
// .factory/hooks/biome-format.mjs
//
// Project-local PostToolUse hook: format the just-edited file with biome
// in `--write` mode. Reads the tool_input JSON from stdin (Claude Code
// sends `tool_name`, `tool_input.file_path`, etc.) and shells out to the
// pinned biome version in the workspace root.
//
// Why this lives here instead of ~/.factory/settings.json: this is a
// project-specific policy ("run biome on every Edit/Write/MultiEdit").
// Universal hooks (SessionStart, UserPromptSubmit, Stop) live at the
// user level so they can be shared across projects; this hook should
// only fire when working in a repo that uses biome.
//
// Why we exit 0 even on biome failure: a formatter hook is auto-repair,
// not a gate. The hook's job is to make the file conform; if it can't,
// we let the regular `pnpm lint` flow surface the issue. Blocking on
// biome failure would block tool calls that aren't actually about
// formatting (e.g. a Markdown edit that accidentally triggers biome
// on a non-formattable path).

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { isAbsolute, join } from "node:path"

// File extensions biome will format. Mirrors the `includes` array in
// biome.json so the hook never tries to format a file the project
// itself has excluded (e.g. pnpm-lock.yaml).
const FORMATTABLE = /\.(ts|tsx|js|mjs|cjs|json|jsonc)$/

async function main() {
	// Drain stdin (Claude Code writes the tool event JSON here).
	const chunks = []
	for await (const chunk of process.stdin) chunks.push(chunk)
	const raw = Buffer.concat(chunks).toString("utf-8").trim()
	if (!raw) return

	let event
	try {
		event = JSON.parse(raw)
	} catch {
		// Malformed input — nothing to do, don't block the tool call.
		return
	}

	const filePath = event?.tool_input?.file_path
	if (typeof filePath !== "string" || filePath.length === 0) return
	if (!FORMATTABLE.test(filePath)) return

	// CLAUDE_PROJECT_DIR is the Claude Code-injected project root;
	// biome's noUndeclaredEnvVars rule only knows about turbo.json's
	// env lists, which is the wrong namespace here.
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: Claude Code system variable, not a turbo env
	const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
	const absPath = isAbsolute(filePath) ? filePath : join(projectDir, filePath)
	if (!existsSync(absPath)) return

	// `biome check --write` both lints and formats in one pass. The
	// `--no-errors-on-unmatched` flag is irrelevant here (we already
	// filtered by extension) but harmless. `|| true` at the call site
	// would suppress the exit code on a missing binary; we explicitly
	// ignore it inside the spawn instead so biome's own diagnostics are
	// preserved on stderr.
	const result = spawnSync("pnpm", ["exec", "biome", "check", "--write", "--no-errors-on-unmatched", absPath], {
		cwd: projectDir,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf-8",
	})

	// Echo biome's stdout/stderr only when something interesting
	// happened (diagnostics or a write). A clean format is silent.
	const out = (result.stdout || "") + (result.stderr || "")
	if (out.trim().length > 0) {
		process.stderr.write(`[biome-format] ${filePath}\n${out}`)
	}

	// Always exit 0 — this is auto-repair, not a gate.
	process.exit(0)
}

main().catch(() => {
	// Any unexpected error: don't block the tool call.
	process.exit(0)
})
