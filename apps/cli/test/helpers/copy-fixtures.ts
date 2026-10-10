import { cpSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

/** Tiny well-formed packs used by tests. Not the product catalog. */
const CLI_FIXTURES_DIR = join(HERE, "..", "fixtures")

const PLATFORM_FIXTURE_NAMES = ["honest-mod", "slot-mod"] as const

export function copyPlatformFixtures(projectRoot: string, names: readonly string[] = PLATFORM_FIXTURE_NAMES): void {
	mkdirSync(join(projectRoot, "packs"), { recursive: true })
	for (const name of names) {
		cpSync(join(CLI_FIXTURES_DIR, name), join(projectRoot, "packs", name), { recursive: true })
	}
}
