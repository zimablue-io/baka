import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { GitFixture } from "./git-fixture"

/**
 * Dry-run fixture helpers (architecture §4.6 layer 2).
 *
 * The static-scan fixture (`git-fixture.ts`) already publishes a
 * loadable action via its default fixture builder. The dry-run
 * tests need additional knobs:
 *
 *   - `body` for the action.ts file (defaults to a noop). The
 *     canary-escape and infinite-loop tests override this with
 *     fixture-specific source.
 *   - `templateFiles` for action templates (Handlebars) — currently
 *     unused by the dry-run executor but reserved for future
 *     validator-gate tests.
 *   - `dependencies` (passthrough from the static-scan fixture).
 *
 * Each helper returns a Promise that resolves once the fixture's
 * git commit is recorded; the caller publishes against the
 * fixture's `bareUrl` exactly like the existing static-scan
 * tests.
 */

export interface DryRunActionFixture {
	/** id of the action (used as the directory name and argv). */
	id: string
	/** Source body for `<id>/action.ts`. */
	body: string
	/** Whether the action declares `requiresReasoning: true`. */
	requiresReasoning?: boolean
	/** Files the action declares under `filePatterns` (for the static scan). */
	filePatterns?: string[]
}

export interface DryRunModuleFixture {
	name: string
	version: string
	tag: string
	modulePath?: string
	dependencies?: string[]
	actions: DryRunActionFixture[]
}

/**
 * Commits a module manifest with multiple loadable actions into
 * the fixture repo. The action bodies come from
 * `DryRunActionFixture.body` so canary-escape / infinite-loop /
 * clean-noop tests can all reuse the same builder.
 *
 * Returns the git fixture's bare URL so the test can publish
 * against it.
 */
export async function publishDryRunFixture(
	git: GitFixture,
	opts: DryRunModuleFixture,
): Promise<void> {
	const modulePath = opts.modulePath ?? ""
	const targetDir = modulePath.length > 0 ? join(git.workDir, modulePath) : git.workDir
	mkdirSync(targetDir, { recursive: true })

	const dependencies = opts.dependencies ?? []
	const renderedActions = opts.actions
		.map(
			(a) =>
				`    { id: ${JSON.stringify(a.id)}, description: ${JSON.stringify(a.id)}, params: [], requiresReasoning: ${a.requiresReasoning ? "true" : "false"}, filePatterns: ${JSON.stringify(a.filePatterns ?? [])}, validators: [] }`,
		)
		.join(",\n")
	const renderedDeps = dependencies.map((d) => JSON.stringify(d)).join(", ")
	const manifest = `export default {
  name: ${JSON.stringify(opts.name)},
  version: ${JSON.stringify(opts.version)},
  description: ${JSON.stringify(`dry-run fixture for ${opts.name}`)},
  dependencies: [${renderedDeps}],
  conflictsWith: [],
  actions: [
${renderedActions}
  ],
  moduleValidators: [],
} satisfies never
`

	writeFileSync(join(targetDir, "manifest.ts"), manifest, "utf8")

	for (const action of opts.actions) {
		const actionDir = join(targetDir, action.id)
		mkdirSync(actionDir, { recursive: true })
		writeFileSync(join(actionDir, "action.ts"), action.body, "utf8")
	}

	const relativePaths: string[] = []
	const manifestRel = modulePath.length > 0 ? `${modulePath}/manifest.ts` : "manifest.ts"
	relativePaths.push(manifestRel)
	for (const action of opts.actions) {
		relativePaths.push(modulePath.length > 0 ? `${modulePath}/${action.id}` : action.id)
	}

	// Use the existing git fixture's commit logic by reusing
	// `commitManifest` with the extras hook. We bypass the
	// fixture's default action-writer by passing empty `actions: []`
	// to commitManifest and writing our own action files above.
	await git.commitManifest({
		name: opts.name,
		version: opts.version,
		description: `dry-run fixture for ${opts.name}`,
		dependencies: opts.dependencies,
		modulePath: opts.modulePath,
		tag: opts.tag,
		actions: opts.actions.map((a) => ({
			id: a.id,
			description: a.id,
			filePatterns: a.filePatterns ?? [],
			requiresReasoning: a.requiresReasoning ?? false,
			validators: [],
		})),
	})
}

/**
 * Default noop action body — runs `execute`, writes nothing,
 * returns success. Used for happy-path tests where the action
 * shape must be loadable but does not need to produce files.
 */
export const NOOP_ACTION_BODY = `export default {
  name: "noop",
  role: 1,
  async execute() {
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`

/**
 * Action body that writes a known file to the sandbox dir. Used
 * for happy-path tests that need at least one rendered preview
 * artifact.
 */
export function fileWriterActionBody(filePath: string, content: string): string {
	return `import { writeFileSync } from "node:fs"
import { join } from "node:path"
export default {
  name: "writer",
  role: 1,
  async execute() {
    writeFileSync(${JSON.stringify(filePath)}, ${JSON.stringify(content)})
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`
}

/**
 * Action body that runs an infinite loop. Used to exercise the
 * timeout path (VAL-SCAN-013) — the dry-run executor SIGKILLs
 * the subprocess after `timeoutMs` and the version verdict
 * becomes `unverified`.
 */
export const INFINITE_LOOP_ACTION_BODY = `export default {
  name: "infinite",
  role: 1,
  async execute() {
    while (true) {}
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`
