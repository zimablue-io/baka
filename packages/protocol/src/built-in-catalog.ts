import { type Catalog, CatalogSchema } from "./catalog"

/**
 * The built-in catalog: the first-party baka modules that ship with the
 * engine. This is the single source of truth; the marketplace API serves it
 * at `/v1/built-in` and the registry seeds its catalog from it.
 *
 * The module entries mirror `modules/<name>/manifest.ts`. When a module
 * manifest changes, update its entry here in the same change.
 *
 * A malformed catalog is a programming error (it ships with the engine),
 * so it is parsed at module load and throws rather than degrading silently.
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
	modules: [
		{
			name: "baka-base",
			version: "0.1.0",
			description: "Minimal hello-world TypeScript project scaffold. Use this as the foundation for any new app.",
			dependencies: [],
			conflictsWith: [],
			actions: [
				{
					id: "scaffold",
					description: "Create a fresh TypeScript project (package.json, tsconfig.json, src/index.ts, README.md).",
					requiresReasoning: false,
					filePatterns: ["package.json", "tsconfig.json", "src/index.ts", "README.md", ".gitignore"],
					validators: ["hasConsoleLog"],
					params: [
						{ name: "name", type: "string", required: true, description: "Project name (kebab-case)." },
						{ name: "description", type: "string", required: false, description: "Short project description." },
						{
							name: "moduleType",
							type: "enum",
							required: false,
							description: "Module system.",
							enumValues: ["esm", "commonjs"],
						},
					],
				},
				{
					id: "add-script",
					description: "Add or update a script entry in package.json. Idempotent.",
					requiresReasoning: false,
					filePatterns: ["package.json"],
					validators: [],
					params: [
						{ name: "name", type: "string", required: true, description: "Script name (e.g. 'build')." },
						{ name: "command", type: "string", required: true, description: "Script command (e.g. 'tsc')." },
					],
				},
				{
					id: "add-dependency",
					description: "Add a runtime or dev dependency to package.json with a pinned version range.",
					requiresReasoning: false,
					filePatterns: ["package.json"],
					validators: [],
					params: [
						{ name: "name", type: "string", required: true, description: "Package name (e.g. 'zod')." },
						{ name: "version", type: "string", required: true, description: "Version range (e.g. '^3.23.0')." },
						{ name: "dev", type: "boolean", required: false, description: "Add to devDependencies (default false)." },
					],
				},
			],
			moduleValidators: ["hasPackageJson", "tsconfigPresent"],
			source: "./modules/baka-base",
			author: { name: "The baka maintainers" },
			license: "MIT",
			tags: ["base", "typescript", "scaffold", "hello-world"],
			category: "base",
			keywords: ["scaffolding", "boilerplate", "starter"],
			accent: "#F5E6A8",
		},
		{
			name: "sdd",
			version: "0.1.0",
			description:
				"Spec-Driven Development. Generates project constitution (mission, tech-stack, roadmap) and per-feature spec folders (plan, requirements, validation) using LLM reasoning over handlebars templates.",
			dependencies: [],
			conflictsWith: [],
			actions: [
				{
					id: "init-constitution",
					description:
						"Create the project constitution: specs/mission.md, specs/tech-stack.md, specs/roadmap.md. Idempotent. Uses LLM to fill each document from a handlebars prompt.",
					requiresReasoning: true,
					filePatterns: ["specs/mission.md", "specs/tech-stack.md", "specs/roadmap.md"],
					validators: ["constitutionCoherent"],
					params: [
						{ name: "productName", type: "string", required: true, description: "Name of the product being built." },
						{
							name: "summary",
							type: "string",
							required: true,
							description: "One-paragraph description of what the product does and who it is for.",
						},
						{
							name: "tone",
							type: "string",
							required: false,
							description: "Tone for mission.md (e.g. 'playful', 'serious', 'technical').",
						},
					],
				},
				{
					id: "create-feature",
					description:
						"Create a per-feature spec folder at specs/YYYY-MM-DD-<name>/ containing plan.md, requirements.md, and validation.md. Uses LLM to generate each from a handlebars prompt.",
					requiresReasoning: true,
					filePatterns: ["specs/*/plan.md", "specs/*/requirements.md", "specs/*/validation.md"],
					validators: ["featureSpecCoherent"],
					params: [
						{
							name: "name",
							type: "string",
							required: true,
							description: "Feature name (kebab-case). Creates specs/YYYY-MM-DD-<name>/.",
						},
						{
							name: "description",
							type: "string",
							required: true,
							description: "One-paragraph description of what this feature does and why.",
						},
						{
							name: "context",
							type: "string",
							required: false,
							description: "Optional extra context (e.g. links, prior decisions).",
						},
					],
				},
			],
			moduleValidators: [],
			source: "./modules/sdd",
			author: { name: "The baka maintainers" },
			license: "MIT",
			tags: ["sdd", "spec-driven", "specs"],
			category: "pattern",
			keywords: ["spec-driven-development", "constitution", "specs"],
			accent: "#F5E6A8",
		},
		{
			name: "ts-style",
			version: "0.1.0",
			description:
				"TypeScript style enforcer. Bundles validators that block `any`, warn on console.log, and require explicit return types on exported functions.",
			dependencies: ["baka-base"],
			conflictsWith: [],
			actions: [
				{
					id: "install-config",
					description: "Drop a strict tsconfig.json and biome.json into the target project.",
					requiresReasoning: false,
					filePatterns: ["tsconfig.json", "biome.json"],
					validators: [],
					params: [
						{
							name: "strict",
							type: "boolean",
							required: false,
							description: "Apply maximum strictness (default true).",
						},
					],
				},
				{
					id: "lint",
					description:
						"Lint the current project with biome and report every diagnostic (file, rule, severity, message, position). Requires a biome configuration in the project (ts-style:install-config provides one); uses the project's own biome when installed, otherwise the copy bundled with ts-style.",
					requiresReasoning: false,
					filePatterns: [],
					validators: [],
					params: [],
				},
			],
			moduleValidators: ["noAnyTypes", "noConsoleLog", "explicitReturnTypes"],
			source: "./modules/ts-style",
			author: { name: "The baka maintainers" },
			license: "MIT",
			tags: ["linter", "typescript", "style", "biome"],
			category: "pattern",
			keywords: ["code-quality", "linting", "formatting"],
			accent: "#F5E6A8",
		},
	],
})
