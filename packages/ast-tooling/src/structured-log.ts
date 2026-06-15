import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir, platform } from "node:os"
import { BAKA_USER_DIR } from "@repo/protocol"

export type LogLevel = "info" | "warn" | "error" | "debug"

export interface LogEntry {
	ts: string
	level: LogLevel
	source: string
	message: string
	[k: string]: unknown
}

/**
 * Append-only JSON-line log writer. The path follows XDG:
 *   $XDG_DATA_HOME/baka/logs/<yyyy-mm-dd>.log on Linux/macOS
 *   %LOCALAPPDATA%/baka/logs/<yyyy-mm-dd>.log on Windows
 * Falls back to ~/.local/share/baka/logs/ if neither is set.
 */
export class StructuredLog {
	private path: string | null = null

	constructor(private readonly runId: string) {}

	resolve(): string {
		if (this.path) return this.path
		const base = dataHome()
		const dir = join(base, BAKA_USER_DIR, "logs")
		mkdirSync(dir, { recursive: true })
		const file = join(dir, `${new Date().toISOString().slice(0, 10)}-${this.runId}.log`)
		this.path = file
		return file
	}

	write(entry: Omit<LogEntry, "ts">): void {
		const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"
		try {
			appendFileSync(this.resolve(), line, "utf-8")
		} catch {
			// Logging must never throw. If the disk is full or the path is
			// unwritable, the run continues; the runId is logged on stderr
			// so the user can still find the in-memory logs at the end.
		}
	}
}

function dataHome(): string {
	const env = process.env
	if (platform() === "win32") {
		return env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
	}
	return env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
}
