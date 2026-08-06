import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Local bare-git fixture for publish-endpoint tests (architecture
 * §4.5 / §6). The validation contract uses real GitHub repos for
 * the fixture repos (FIXTURE_OK_REPO etc.), but the registry's
 * hermetic tests should not depend on network access — the mission
 * readiness summary explicitly calls out "unauthenticated API limit
 * 60/h" as the reason to prefer local bare repos in tmp dirs.
 *
 * Each fixture creates a bare source repo, a working tree that
 * commits the manifest at a given tag, and exposes the source URL
 * (the `file://` path to the bare repo) for the publish endpoint
 * to clone. Cleanup removes both the bare repo and the working
 * tree on `close()`.
 *
 * Usage:
 *   const fx = await createGitFixture()
 *   await fx.commitManifest({
 *     name: "my-mod",
 *     version: "1.0.0",
 *     description: "...",
 *   }, "v1.0.0")
 *   const repoUrl = fx.bareUrl
 *   // ... publish against `repoUrl` ...
 *   await fx.cleanup()
 */

export interface GitFixture {
	/** file:// URL pointing at the bare repository. */
	bareUrl: string
	/** Absolute path to the working tree (post-clone). */
	workDir: string
	/**
	 * Commits `manifestSource` at the repo root (or under
	 * `modulePath` when supplied) at the given `tag`. The
	 * commit is the only content the publish endpoint will
	 * see.
	 */
	commitManifest: (args: {
		name: string
		version: string
		description?: string
		dependencies?: string[]
		actions?: Array<{ id: string; description?: string; filePatterns?: string[]; requiresReasoning?: boolean }>
		modulePath?: string
		tag: string
		manifestFormat?: "ts" | "json"
	}) => Promise<{ commitSha: string }>
	cleanup: () => Promise<void>
}

function exec(args: { cmd: string; args: string[]; cwd?: string }): string {
	const result = execFileSync(args.cmd, args.args, {
		cwd: args.cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	})
	return result.trim()
}

function manifestSource(opts: {
	name: string
	version: string
	description?: string
	dependencies?: string[]
	actions?: Array<{ id: string; description?: string; filePatterns?: string[]; requiresReasoning?: boolean }>
}): string {
	const description = opts.description ?? `module ${opts.name}`
	const dependencies = opts.dependencies ?? []
	const actions = opts.actions ?? [
		{
			id: "noop",
			description: "no-op action",
			filePatterns: [],
			requiresReasoning: false,
		},
	]
	const renderedActions = actions
		.map(
			(a) =>
				`    { id: ${JSON.stringify(a.id)}, description: ${JSON.stringify(a.description ?? "")}, params: [], requiresReasoning: ${a.requiresReasoning ? "true" : "false"}, filePatterns: ${JSON.stringify(a.filePatterns ?? [])}, validators: [] }`,
		)
		.join(",\n")
	const renderedDeps = dependencies.map((d) => JSON.stringify(d)).join(", ")
	return `export default {
  name: ${JSON.stringify(opts.name)},
  version: ${JSON.stringify(opts.version)},
  description: ${JSON.stringify(description)},
  dependencies: [${renderedDeps}],
  conflictsWith: [],
  actions: [
${renderedActions}
  ],
  moduleValidators: [],
} satisfies never
`
}

export async function createGitFixture(): Promise<GitFixture> {
	const baseDir = await mkdtemp(join(tmpdir(), "baka-git-fixture-"))
	const bareDir = join(baseDir, "bare.git")
	const workDir = join(baseDir, "work")
	await mkdir(bareDir, { recursive: true })
	await mkdir(workDir, { recursive: true })

	exec({ cmd: "git", args: ["init", "--bare", bareDir] })
	// Ensure HEAD points at the default branch name so shallow
	// clones don't trip a "unknown revision" warning.
	exec({ cmd: "git", args: ["--git-dir", bareDir, "symbolic-ref", "HEAD", "refs/heads/main"] })

	// Initialize the working tree as a normal repo and add the
	// bare repo as its `origin` so `git push` works.
	exec({ cmd: "git", args: ["init", "-b", "main", workDir] })
	exec({ cmd: "git", args: ["-C", workDir, "remote", "add", "origin", bareDir] })

	// Set up a minimal local user identity so commits succeed.
	// The values are pinned to the fixture's life — no real
	// operator identity is leaked.
	try {
		exec({ cmd: "git", args: ["-C", workDir, "config", "user.email", "fixture@baka.local"] })
		exec({ cmd: "git", args: ["-C", workDir, "config", "user.name", "baka-fixture"] })
	} catch {
		// ignore — local-only
	}

	return {
		bareUrl: bareDir.startsWith("/") ? `file://${bareDir}` : `file:///${bareDir.replace(/\\/g, "/")}`,
		workDir,
		async commitManifest(opts) {
			const modulePath = opts.modulePath ?? ""
			const targetDir = modulePath.length > 0 ? join(workDir, modulePath) : workDir
			await mkdir(targetDir, { recursive: true })
			const sourceExt = opts.manifestFormat ?? "ts"
			const filename = sourceExt === "json" ? "manifest.json" : "manifest.ts"
			const body =
				sourceExt === "json" ? JSON.stringify(manifestToJsonShape(opts), null, 2) + "\n" : manifestSource(opts)
			await writeFile(join(targetDir, filename), body, "utf8")
			exec({ cmd: "git", args: ["-C", workDir, "add", filename] })
			if (modulePath.length > 0) {
				exec({ cmd: "git", args: ["-C", workDir, "add", modulePath] })
			}
			exec({ cmd: "git", args: ["-C", workDir, "commit", "-m", `manifest for ${opts.tag}`] })
			exec({ cmd: "git", args: ["-C", workDir, "tag", opts.tag] })
			exec({ cmd: "git", args: ["-C", workDir, "push", "origin", opts.tag] })
			exec({ cmd: "git", args: ["-C", workDir, "push", "origin", "HEAD:refs/heads/main"] })
			const commitSha = exec({ cmd: "git", args: ["-C", workDir, "rev-parse", "HEAD"] })
			return { commitSha }
		},
		async cleanup() {
			await rm(baseDir, { recursive: true, force: true }).catch(() => {})
		},
	}
}

function manifestToJsonShape(opts: {
	name: string
	version: string
	description?: string
	dependencies?: string[]
	actions?: Array<{ id: string; description?: string; filePatterns?: string[]; requiresReasoning?: boolean }>
}): Record<string, unknown> {
	return {
		name: opts.name,
		version: opts.version,
		description: opts.description ?? `module ${opts.name}`,
		dependencies: opts.dependencies ?? [],
		conflictsWith: [],
		actions: opts.actions ?? [
			{
				id: "noop",
				description: "no-op action",
				params: [],
				requiresReasoning: false,
				filePatterns: [],
				validators: [],
			},
		],
		moduleValidators: [],
	}
}
