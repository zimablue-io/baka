import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { bakaHomeDir } from "@repo/protocol"

export type LogLevel = "info" | "warn" | "error" | "debug"

export interface LogEntry {
	ts: string
	level: LogLevel
	source: string
	message: string
	[k: string]: unknown
}

/**
 * Append-only JSON-line log writer. Writes to
 * ${BAKA_HOME:-$HOME/.baka}/logs/<yyyy-mm-dd>-<runId>.log.
 */
export class StructuredLog {
	private path: string | null = null

	constructor(private readonly runId: string) {}

	resolve(): string {
		if (this.path) return this.path
		const dir = join(bakaHomeDir(), "logs")
		mkdirSync(dir, { recursive: true })
		const file = join(dir, `${new Date().toISOString().slice(0, 10)}-${this.runId}.log`)
		this.path = file
		return file
	}

	write(entry: Omit<LogEntry, "ts">): void {
		const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`
		try {
			appendFileSync(this.resolve(), line, "utf-8")
		} catch {
			// Logging must never throw. If the disk is full or the path is
			// unwritable, the run continues; the runId is logged on stderr
			// so the user can still find the in-memory logs at the end.
		}
	}
}
