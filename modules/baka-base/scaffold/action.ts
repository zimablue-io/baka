import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { StepResponse, WorkflowStep } from "baka-sdk"
import { AgentRole } from "baka-sdk"

export interface ScaffoldInput {
	name: string
	description?: string
	moduleType?: "esm" | "commonjs"
}

export interface ScaffoldCompensationData {
	targetDirectory: string
	createdFiles: string[]
	projectName: string
}

export const scaffoldAction: WorkflowStep<ScaffoldInput, boolean, ScaffoldCompensationData> = {
	name: "baka-base.scaffold",
	role: AgentRole.WORKER,

	execute: async (input, state): Promise<StepResponse<boolean, ScaffoldCompensationData>> => {
		const target = state.targetDirectory
		const projectName = input.name
		const moduleType = input.moduleType ?? "esm"
		const description = input.description ?? ""

		const created: string[] = []
		try {
			if (!/^[a-z0-9-_]+$/.test(projectName)) {
				throw new Error(`project name must be kebab-case: ${projectName}`)
			}

			const write = (rel: string, content: string) => {
				const full = join(target, rel)
				mkdirSync(join(full, ".."), { recursive: true })
				writeFileSync(full, content, "utf-8")
				created.push(full)
			}

			// Skip files that already exist (idempotent). We only track newly
			// created files for compensation.
			const ensureNew = (rel: string, content: string) => {
				const full = join(target, rel)
				if (existsSync(full)) return
				write(rel, content)
			}

			ensureNew("package.json", renderPackageJson(projectName, description, moduleType))
			ensureNew("tsconfig.json", renderTsConfig(moduleType))
			ensureNew("src/index.ts", renderIndex())
			ensureNew("README.md", renderReadme(projectName, description))
			ensureNew(".gitignore", renderGitignore())

			return {
				success: true,
				output: true,
				compensationData: { targetDirectory: target, createdFiles: created, projectName },
			}
		} catch (err) {
			return {
				success: false,
				output: false,
				compensationData: { targetDirectory: target, createdFiles: created, projectName },
				error: err instanceof Error ? err.message : String(err),
			}
		}
	},

	compensate: async (data, _state): Promise<void> => {
		const { rmSync } = require("node:fs") as typeof import("node:fs")
		// Roll back only the files we created. The compensate is best-effort.
		for (const file of data.createdFiles) {
			try {
				rmSync(file, { force: true })
			} catch {
				/* best effort */
			}
		}
	},
}

function renderPackageJson(name: string, description: string, moduleType: "esm" | "commonjs"): string {
	return `${JSON.stringify(
		{
			name,
			version: "0.1.0",
			private: true,
			description,
			type: moduleType === "esm" ? "module" : "commonjs",
			scripts: {
				build: "tsc",
				start: "node dist/index.js",
				check: "tsc --noEmit",
			},
			devDependencies: {
				"@types/node": "^22.0.0",
				typescript: "^5.9.0",
			},
		},
		null,
		"\t",
	)}\n`
}

function renderTsConfig(moduleType: "esm" | "commonjs"): string {
	return `{
	"compilerOptions": {
		"target": "ES2022",
		"module": ${moduleType === "esm" ? '"ESNext"' : '"CommonJS"'},
		"moduleResolution": "Bundler",
		"esModuleInterop": true,
		"strict": true,
		"skipLibCheck": true,
		"outDir": "dist",
		"rootDir": "src",
		"declaration": true,
		"sourceMap": true
	},
	"include": ["src"]
}
`
}

function renderIndex(): string {
	return `console.log("hello from project")
`
}

function renderReadme(name: string, description: string): string {
	return `# ${name}

${description || "(no description)"}

## Scripts

- \`pnpm build\` — compile TypeScript to \`dist/\`
- \`pnpm start\` — run the compiled output
- \`pnpm check\` — type-check only
`
}

function renderGitignore(): string {
	return `node_modules/
dist/
*.log
.DS_Store
.env
.env.local
`
}
