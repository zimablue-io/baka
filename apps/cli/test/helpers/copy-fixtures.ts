import { cpSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

/** Tiny well-formed modules used by tests. Not the product catalog. */
export const CLI_FIXTURES_DIR = join(HERE, "..", "fixtures")

export const PLATFORM_FIXTURE_NAMES = ["honest-mod", "slot-mod"] as const

export function copyPlatformFixtures(projectRoot: string, names: readonly string[] = PLATFORM_FIXTURE_NAMES): void {
	mkdirSync(join(projectRoot, "modules"), { recursive: true })
	for (const name of names) {
		cpSync(join(CLI_FIXTURES_DIR, name), join(projectRoot, "modules", name), { recursive: true })
	}
}
