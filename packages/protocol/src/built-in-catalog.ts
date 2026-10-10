import { type Catalog, CatalogSchema } from "./catalog"

/**
 * First-party packs that ship inside the engine package.
 * The engine is a platform: real packs are installed into a project
 * (`packs/`, `.baka/packs`, or `$BAKA_HOME/packs`). This catalog
 * stays empty until a pack is actually productized and published.
 */
export const BUILT_IN_CATALOG: Catalog = CatalogSchema.parse({
	name: "baka-built-in",
	version: "1.0.0",
	description: "First-party baka packs that ship with the engine.",
	owner: {
		name: "The baka maintainers",
		email: "maintainers@baka.foo",
	},
	homepage: "https://github.com/zimablue-io/baka/tree/main/packs",
	packs: [],
})
