import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { bakaHomeDir } from "./baka-home"

const prevBakaHome = process.env.BAKA_HOME
const prevHome = process.env.HOME
const tempDirs: string[] = []

afterEach(() => {
	if (prevBakaHome === undefined) delete process.env.BAKA_HOME
	else process.env.BAKA_HOME = prevBakaHome
	if (prevHome === undefined) delete process.env.HOME
	else process.env.HOME = prevHome
	for (const d of tempDirs.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	}
})

function mkTemp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix))
	tempDirs.push(d)
	return d
}

describe("bakaHomeDir (architecture decision 33)", () => {
	it("returns $BAKA_HOME verbatim when the env var is set", () => {
		const bakaHome = mkTemp("baka-home-env-")
		process.env.BAKA_HOME = bakaHome
		process.env.HOME = mkTemp("baka-home-other-home-")
		expect(bakaHomeDir()).toBe(bakaHome)
	})

	it("falls back to $HOME/.baka when BAKA_HOME is unset", () => {
		delete process.env.BAKA_HOME
		const home = mkTemp("baka-home-fallback-")
		process.env.HOME = home
		expect(bakaHomeDir()).toBe(join(home, ".baka"))
	})
})
