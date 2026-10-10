import { homedir } from "node:os"
import { join } from "node:path"
import { BAKA_USER_DIR } from "./constants"

/**
 * The single resolution path for baka's user-level directory (architecture
 * decision 33): `$BAKA_HOME` when the env var is set, `$HOME/.baka`
 * otherwise. The config file lands at `bakaHomeDir()/config.json` and the
 * user marketplace at `bakaHomeDir()/packs`. Every user-level resolution
 * site (config store, registry user scope, package manager, marketplace
 * catalogs, structured log) goes through this helper.
 */
export function bakaHomeDir(): string {
	return process.env.BAKA_HOME ?? join(homedir(), `.${BAKA_USER_DIR}`)
}
