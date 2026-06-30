import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMProvider, LLMRequest, LLMResponse, ModuleManifest } from "@repo/protocol"
import { afterEach, describe, expect, it } from "vitest"
import { createInitialOrchestrationState, createOrchestratePlanningStep } from "./index"

// ---------------------------------------------------------------------------
// Battle-test: loadModulePreferences must read PREFERENCES.md from the
// NEW user marketplace path (~/.baka/modules/<name>/PREFERENCES.md), not
// the retired ~/.local/share/baka/modules/ path.
//
// The commit 0b5331d migrated discovery.ts and package-manager.ts to
// ~/.baka/modules, but loadModulePreferences (index.ts:302) still reads
// ~/.local/share/baka/modules. A module installed via the marketplace is
// discovered from ~/.baka/modules, yet its PREFERENCES.md is never loaded
// into the orchestrator prompt. This test fails for the RIGHT reason: the
// stale path means the sentinel content is absent from the prompt.
// ---------------------------------------------------------------------------

const cleanup: string[] = []
const prevHome = process.env.HOME
const prevCwd = process.cwd()

afterEach(() => {
	process.env.HOME = prevHome
	try {
		process.chdir(prevCwd)
	} catch {
		/* best effort */
	}
	for (const d of cleanup.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	}
})

/** Minimal fake provider that records the user-message content (the prompt). */
function capturingProvider(captured: { prompt: string }): LLMProvider {
	return {
		name: "fake",
		chat: <T>(_request: LLMRequest): Promise<LLMResponse<T>> => {
			const userMsg = _request.messages.find((m) => m.role === "user")
			if (userMsg) captured.prompt = userMsg.content
			return Promise.resolve({
				content: { resolvedSteps: [] } as unknown as T,
				usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
				raw: null,
			})
		},
		validateConfig: () => {},
	}
}

const PREFS_SENTINEL = "BATTLE_SENTINEL_PREFS_42"

describe("loadModulePreferences user-scope path (battle)", () => {
	it("loads PREFERENCES.md from ~/.baka/modules/<name>/ (not ~/.local/share/baka)", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "baka-prefs-home-"))
		cleanup.push(fakeHome)
		process.env.HOME = fakeHome

		// Isolate cwd so the cwd-based candidate paths cannot match.
		const fakeCwd = mkdtempSync(join(tmpdir(), "baka-prefs-cwd-"))
		cleanup.push(fakeCwd)
		process.chdir(fakeCwd)

		// Materialise a marketplace module at the NEW path ~/.baka/modules.
		const modDir = join(fakeHome, ".baka", "modules", "battle-prefs-mod")
		mkdirSync(modDir, { recursive: true })
		writeFileSync(join(modDir, "PREFERENCES.md"), `# Preferences\n\nAlways use ${PREFS_SENTINEL} as the marker.\n`)

		// Do NOT create anything under ~/.local/share/baka (the stale path).

		const manifest: ModuleManifest = {
			name: "battle-prefs-mod",
			version: "0.1.0",
			description: "battle prefs",
			dependencies: [],
			conflictsWith: [],
			actions: [
				{
					id: "doThing",
					description: "does a thing",
					params: [{ name: "name", type: "string", required: true, description: "name" }],
					requiresReasoning: false,
					filePatterns: [],
					validators: [],
				},
			],
			moduleValidators: [],
		}

		const captured = { prompt: "" }
		const step = createOrchestratePlanningStep(capturingProvider(captured))
		const state = createInitialOrchestrationState("do the thing", fakeCwd)

		await step.execute({ intent: "do the thing", availableModules: [manifest] }, state)

		// If loadModulePreferences read the correct path, the sentinel appears.
		expect(captured.prompt).toContain(PREFS_SENTINEL)
	})
})
