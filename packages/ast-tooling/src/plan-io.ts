import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BAKA_PROJECT_PATHS, type ResolvedPlan } from "@repo/protocol"

export interface SavedPlan extends ResolvedPlan {
	// Saved plans carry their origin metadata so the apply step can show
	// provenance and so re-plans can be diffed against the original.
	meta: {
		intent: string
		savedAt: string
		model?: string
	}
}

export function plansDir(targetDirectory: string): string {
	return join(targetDirectory, BAKA_PROJECT_PATHS.PLANS)
}

export function savePlan(targetDirectory: string, intent: string, plan: ResolvedPlan, model?: string): string {
	const dir = plansDir(targetDirectory)
	mkdirSync(dir, { recursive: true })
	const file = join(dir, `${Date.now()}.plan.json`)
	const saved: SavedPlan = {
		...plan,
		meta: {
			intent,
			savedAt: new Date().toISOString(),
			...(model ? { model } : {}),
		},
	}
	writeFileSync(file, JSON.stringify(saved, null, 2), "utf-8")
	return file
}

export function loadPlan(file: string): SavedPlan {
	if (!existsSync(file)) {
		throw new Error(`plan file not found: ${file}`)
	}
	const raw = JSON.parse(readFileSync(file, "utf-8")) as SavedPlan
	if (!raw.meta || !Array.isArray(raw.resolvedSteps)) {
		throw new Error(`plan file is malformed: ${file}`)
	}
	return raw
}

export function listPlans(targetDirectory: string): Array<{ file: string; meta: SavedPlan["meta"] }> {
	const dir = plansDir(targetDirectory)
	if (!existsSync(dir)) return []
	return readdirSync(dir)
		.filter((f) => f.endsWith(".plan.json"))
		.map((f) => {
			const file = join(dir, f)
			const plan = loadPlan(file)
			return { file, meta: plan.meta }
		})
		.sort((a, b) => a.meta.savedAt.localeCompare(b.meta.savedAt))
}
