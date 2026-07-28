import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import type { StepResponse, WorkflowStep } from "baka-sdk"
import { AgentRole } from "baka-sdk"

export type LintInput = Record<string, never>

export interface LintDiagnostic {
	file: string | null
	rule: string
	severity: string
	message: string
	line: number | null
	column: number | null
}

export interface LintReport {
	target: string
	biome: string | null
	errors: number
	warnings: number
	infos: number
	diagnostics: LintDiagnostic[]
}

export interface LintCompensationData {
	targetDirectory: string
	ranBiome: boolean
}

interface BiomeJsonDiagnostic {
	severity?: string
	message?: unknown
	category?: string
	location?: {
		path?: unknown
		start?: { line?: number; column?: number }
	}
}

interface BiomeJsonReport {
	summary?: { errors?: number; warnings?: number; infos?: number }
	diagnostics?: BiomeJsonDiagnostic[]
}

const BIOME_BIN_REL = join("node_modules", "@biomejs", "biome", "bin", "biome")

/**
 * Resolve the biome executable: the project's own install first (walking up
 * from the analyzed directory, so a monorepo root install counts), then the
 * copy bundled with the ts-style module. Null when neither is available.
 */
export function resolveBiomeBin(startDir: string): string | null {
	let dir = startDir
	for (;;) {
		const candidate = join(dir, BIOME_BIN_REL)
		if (existsSync(candidate)) return candidate
		const parent = dirname(dir)
		if (parent === dir) return bundledBiomeBin()
		dir = parent
	}
}

function bundledBiomeBin(): string | null {
	try {
		// Resolves from this action file's location, i.e. the ts-style module's
		// own dependency closure (the engine's loader provides require).
		const pkgJson = require.resolve("@biomejs/biome/package.json")
		return join(dirname(pkgJson), "bin", "biome")
	} catch {
		return null
	}
}

export const lintAction: WorkflowStep<LintInput, LintReport, LintCompensationData> = {
	name: "ts-style.lint",
	role: AgentRole.WORKER,

	execute: async (_input, _state): Promise<StepResponse<LintReport, LintCompensationData>> => {
		// Lint analyzes the project baka was invoked in. The engine sets
		// state.targetDirectory to the invocation cwd on every production path;
		// `baka module test` substitutes an isolated copy of the module itself,
		// which is the wrong subject for a project-analysis action.
		const target = process.cwd()
		const emptyReport: LintReport = { target, biome: null, errors: 0, warnings: 0, infos: 0, diagnostics: [] }

		if (!existsSync(join(target, "biome.json")) && !existsSync(join(target, "biome.jsonc"))) {
			return {
				success: false,
				output: emptyReport,
				compensationData: { targetDirectory: target, ranBiome: false },
				error: `no biome configuration found in ${target}; run the ts-style:install-config action first (or add a biome.json)`,
			}
		}

		const biomeBin = resolveBiomeBin(target)
		if (!biomeBin) {
			return {
				success: false,
				output: emptyReport,
				compensationData: { targetDirectory: target, ranBiome: false },
				error: `biome is not installed for ${target} and the copy bundled with ts-style is unavailable; install @biomejs/biome in the project (e.g. \`pnpm add -D @biomejs/biome\`)`,
			}
		}

		const ran = await runBiomeLint(biomeBin, target)
		if (!ran.ok) {
			return {
				success: false,
				output: { ...emptyReport, biome: biomeBin },
				compensationData: { targetDirectory: target, ranBiome: false },
				error: ran.error,
			}
		}

		return {
			success: true,
			output: { ...ran.report, target, biome: biomeBin },
			compensationData: { targetDirectory: target, ranBiome: true },
		}
	},

	compensate: async (_data, _state): Promise<void> => {
		// Lint is read-only; nothing to compensate.
	},
}

type BiomeRun = { ok: true; report: Omit<LintReport, "target" | "biome"> } | { ok: false; error: string }

function runBiomeLint(bin: string, cwd: string): Promise<BiomeRun> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [bin, "lint", "--reporter=json", "."], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (chunk) => {
			stdout += chunk
		})
		child.stderr.on("data", (chunk) => {
			stderr += chunk
		})
		child.on("error", (err) => {
			resolve({ ok: false, error: `failed to run biome: ${err.message}` })
		})
		child.on("close", (code) => {
			const report = parseBiomeReport(stdout)
			if (!report) {
				const lastLine = stderr.trim().split("\n").pop() ?? "(no output)"
				resolve({ ok: false, error: `biome exited with code ${code} without a readable report: ${lastLine}` })
				return
			}
			resolve({ ok: true, report })
		})
	})
}

function parseBiomeReport(stdout: string): Omit<LintReport, "target" | "biome"> | null {
	let parsed: BiomeJsonReport
	try {
		parsed = JSON.parse(stdout) as BiomeJsonReport
	} catch {
		return null
	}
	if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.diagnostics)) return null
	const diagnostics: LintDiagnostic[] = parsed.diagnostics.map((d) => ({
		file: typeof d.location?.path === "string" ? d.location.path : null,
		rule: typeof d.category === "string" ? d.category : "unknown",
		severity: d.severity ?? "error",
		message: typeof d.message === "string" ? d.message : String(d.message ?? ""),
		line: typeof d.location?.start?.line === "number" ? d.location.start.line : null,
		column: typeof d.location?.start?.column === "number" ? d.location.start.column : null,
	}))
	return {
		errors: parsed.summary?.errors ?? 0,
		warnings: parsed.summary?.warnings ?? 0,
		infos: parsed.summary?.infos ?? 0,
		diagnostics,
	}
}
