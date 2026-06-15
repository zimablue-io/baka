// Static, hand-curated catalog of the in-tree modules shipped with this repo.
// Sourced from modules/<name>/manifest.ts. Update when new modules land.

export interface CatalogModule {
	readonly name: string
	readonly version: string
	readonly description: string
	readonly actions: number
	readonly path: string
}

export const modules: readonly CatalogModule[] = [
	{
		name: "baka-base",
		version: "0.1.0",
		description: "Minimal hello-world TypeScript project scaffold. The foundation for any new app.",
		actions: 3,
		path: "modules/baka-base",
	},
	{
		name: "ts-style",
		version: "0.1.0",
		description:
			"TypeScript style enforcer. Validators block `any`, warn on console.log, require explicit return types.",
		actions: 2,
		path: "modules/ts-style",
	},
]
