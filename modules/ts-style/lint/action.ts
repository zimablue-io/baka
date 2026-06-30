import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { StepResponse, WorkflowStep } from "baka-sdk"
import { AgentRole } from "baka-sdk"

export type LintInput = Record<string, never>

export interface LintCompensationData {
	targetDirectory: string
	ranBiome: boolean
}

export const lintAction: WorkflowStep<LintInput, boolean, LintCompensationData> = {
	name: "ts-style.lint",
	role: AgentRole.WORKER,

	execute: async (_input, state): Promise<StepResponse<boolean, LintCompensationData>> => {
		const target = state.targetDirectory
		const hasBiome = existsSync(join(target, "biome.json"))
		if (!hasBiome) {
			return {
				success: false,
				output: false,
				compensationData: { targetDirectory: target, ranBiome: false },
				error: "biome.json not found; run ts-style.install-config first",
			}
		}
		// Phase 6 stub: try to run `biome check` and translate its exit code
		// into success/failure. Phase 8 wraps this in a real Worker step with
		// cancellation and structured log capture.
		return new Promise((resolve) => {
			const child = spawn("npx", ["--no-install", "@biomejs/biome", "check", "."], {
				cwd: target,
				stdio: "inherit",
			})
			child.on("exit", (code) => {
				resolve({
					success: code === 0,
					output: code === 0,
					compensationData: { targetDirectory: target, ranBiome: true },
					error: code === 0 ? undefined : `biome exited with code ${code}`,
				})
			})
			child.on("error", (err) => {
				resolve({
					success: false,
					output: false,
					compensationData: { targetDirectory: target, ranBiome: false },
					error: err.message,
				})
			})
		})
	},

	compensate: async (_data, _state): Promise<void> => {
		// Lint is read-only; no compensation needed.
	},
}
