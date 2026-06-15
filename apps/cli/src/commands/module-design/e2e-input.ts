// ---------------------------------------------------------------------------
// E2E input source. When the BAKA_E2E_INPUT env var points to a file,
// the CLI reads all user input (brief, chat prompts, approval gates)
// from that file instead of inquirer. This lets the subprocess tests
// drive the CLI without a real TTY (inquirer requires one).
//
// The file contains one response per line, in the order the CLI asks.
// The cursor advances with each `next()` call.
// ---------------------------------------------------------------------------

import { closeSync, openSync, readSync } from "node:fs"

export function isE2EMode(): boolean {
	return Boolean(process.env.BAKA_E2E_INPUT)
}

export interface E2EInputSource {
	next(): string | null
	reset(): void
}

/** Read the responses from a file (one per line, blank lines skipped). */
export function readResponses(path: string): string[] {
	const fd = openSync(path, "r")
	try {
		const buf = Buffer.alloc(64 * 1024)
		let total = 0
		const chunks: Buffer[] = []
		while (true) {
			const n = readSync(fd, buf, 0, buf.length, total)
			if (n <= 0) break
			chunks.push(buf.subarray(0, n))
			total += n
		}
		const all = Buffer.concat(chunks).toString("utf-8")
		return all
			.split("\n")
			.map((l) => l.replace(/\r$/, ""))
			.filter((l) => l.length > 0)
	} finally {
		closeSync(fd)
	}
}

/**
 * Build a cursor-based input source. The default reads from the
 * BAKA_E2E_INPUT env var; tests can pass an explicit path.
 */
export function createE2EInputSource(path?: string): E2EInputSource {
	const effectivePath = path ?? process.env.BAKA_E2E_INPUT ?? ""
	const responses = effectivePath ? readResponses(effectivePath) : []
	let cursor = 0
	return {
		next: (): string | null => {
			if (cursor >= responses.length) return null
			return responses[cursor++] ?? null
		},
		reset: () => {
			cursor = 0
		},
	}
}

/** Process-wide default source backed by BAKA_E2E_INPUT. */
let defaultSource: E2EInputSource | null = null
export function getDefaultE2EInputSource(): E2EInputSource {
	if (!defaultSource) defaultSource = createE2EInputSource()
	return defaultSource
}
export function resetDefaultE2EInputSource(): void {
	defaultSource = null
}
