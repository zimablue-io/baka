import { type Catalog, CatalogSchema } from "./catalog"

/**
 * First-party modules that ship inside the engine package.
 * The engine is a platform: real modules are installed into a project
 * (`modules/`, `.baka/modules`, or `$BAKA_HOME/modules`). This catalog
 * stays empty until a module is actually productized and published.
 */
export const BUILT_IN_CATALOG: Catalog = CatalogSchema.parse({
	name: "baka-built-in",
	version: "1.0.0",
	description: "First-party baka modules that ship with the engine.",
	owner: {
		name: "The baka maintainers",
		email: "maintainers@baka.foo",
	},
	homepage: "https://github.com/zimablue-io/baka/tree/main/modules",
	modules: [],
})
