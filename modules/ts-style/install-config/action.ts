import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { StepResponse, WorkflowStep } from "baka-sdk"
import { AgentRole } from "baka-sdk"

export interface InstallConfigInput {
	strict?: boolean
}

export interface InstallConfigCompensationData {
	targetDirectory: string
	created: string[]
}

export const installConfigAction: WorkflowStep<InstallConfigInput, boolean, InstallConfigCompensationData> = {
	name: "ts-style.install-config",
	role: AgentRole.WORKER,

	execute: async (input, state): Promise<StepResponse<boolean, InstallConfigCompensationData>> => {
		const target = state.targetDirectory
		const created: string[] = []
		const strict = input.strict ?? true
		try {
			const write = (rel: string, content: string) => {
				const full = join(target, rel)
				if (existsSync(full)) return
				mkdirSync(join(full, ".."), { recursive: true })
				writeFileSync(full, content, "utf-8")
				created.push(full)
			}
			write("tsconfig.json", renderTsConfig(strict))
			write("biome.json", renderBiome())
			return {
				success: true,
				output: true,
				compensationData: { targetDirectory: target, created },
			}
		} catch (err) {
			return {
				success: false,
				output: false,
				compensationData: { targetDirectory: target, created },
				error: err instanceof Error ? err.message : String(err),
			}
		}
	},

	compensate: async (data, _state): Promise<void> => {
		const { rmSync } = require("node:fs") as typeof import("node:fs")
		for (const f of data.created) {
			try {
				rmSync(f, { force: true })
			} catch {
				/* best effort */
			}
		}
	},
}

function renderTsConfig(strict: boolean): string {
	const base = {
		compilerOptions: {
			target: "ES2022",
			module: "ESNext",
			moduleResolution: "Bundler",
			esModuleInterop: true,
			skipLibCheck: true,
			strict: strict ? true : false,
			noUncheckedIndexedAccess: strict ? true : false,
			noImplicitOverride: strict ? true : false,
			exactOptionalPropertyTypes: strict ? true : false,
			noFallthroughCasesInSwitch: strict ? true : false,
			noPropertyAccessFromIndexSignature: strict ? true : false,
			outDir: "dist",
			rootDir: "src",
			declaration: true,
			sourceMap: true,
		},
		include: ["src", "modules"],
	}
	return JSON.stringify(base, null, "\t") + "\n"
}

function renderBiome(): string {
	return (
		JSON.stringify(
			{
				$schema: "https://biomejs.dev/schemas/1.9.0/schema.json",
				linter: { enabled: true, rules: { recommended: true } },
				formatter: { enabled: true, indentStyle: "tab", indentWidth: 4 },
				javascript: { formatter: { quoteStyle: "double", semicolons: "asNeeded", trailingCommas: "all" } },
			},
			null,
			"\t",
		) + "\n"
	)
}
