/**
 * Sandboxed dry-run subprocess script (architecture §4.6 layer 2).
 *
 * The script is passed to `node --permission -e <SCRIPT>` and is the
 * executor that runs ONE recipe in an isolated subprocess. The
 * parent (`dry-run.ts`) spawns one subprocess per non-reasoning
 * recipe and parses the JSON envelope on stdout.
 *
 * Contract with the parent:
 *   argv (after `--` separator):
 *     --recipe-id  <id>      manifest-declared recipe id
 *     --pack-dir <path>    realpath-resolved pack root (read scope)
 *     --sandbox-dir <path>   realpath-resolved empty temp dir (write scope)
 *     --jiti-root <path>     directory jiti uses for resolving
 *                            workspace imports (the registry install
 *                            root, or the workspace root in dev/test)
 *     --mode <m>             OPTIONAL — defaults to "execute";
 *                            "render-sentinel" walks
 *                            <packDir>/<recipeId>/templates/ for
 *                            {{!-- no-llm --}} marked `.hbs` /
 *                            `.handlebars` files, renders each via
 *                            Handlebars with the empty fixture
 *                            params, writes the rendered bytes to
 *                            the sandbox. Used by reasoning recipes
 *                            whose templates ship a sentinel (see
 *                            dry-run.ts reasoning branch).
 *     --canary-config <json> OPTIONAL — test-only channel
 *                            (architecture §8 decision 39): the
 *                            JSON object is decoded and written
 *                            verbatim to <sandboxDir>/_canary.json
 *                            BEFORE chdir so the recipe can read
 *                            it via readFileSync. The parent only
 *                            forwards this argv when its own
 *                            process env has
 *                            BAKA_DRYRUN_TEST_CANARY_CONFIG set.
 *                            Production deployments never set that
 *                            env var, so the file is never
 *                            materialized and the argv is absent.
 *
 *   stdout: a single JSON object per invocation:
 *     { "success": true,  "files": [{ "path": "...", "size": N }, ...] }
 *     { "success": false, "error": "ERR_ACCESS_DENIED: ..." }
 *
 *   exit code:
 *     0 — recipe ran successfully (the stdout JSON has success: true).
 *         The recipe's execute() returning { success: false, error: ... }
 *         is treated as a soft failure: the produced files are still
 *         recorded, but the verdict text carries the error and the
 *         preview state becomes 'failed'. The script still exits 0 in
 *         that case so the parent can distinguish a hard load error
 *         (script exits 1) from a recipe-level soft failure.
 *     1 — hard failure: the recipe could not be loaded (jiti throw),
 *         the script could not parse its argv, the sentinel template
 *         did not compile, or the filesystem walk exploded. The
 *         error message is on stdout.
 *
 * Sandbox enforcement (parent-side, not the script):
 *   - --allow-fs-read=<pack-dir>,<sandbox-dir>,<jiti-root>
 *   - --allow-fs-write=<sandbox-dir>
 *   - env is SCRUBBED to {PATH, HOME, TMPDIR, NODE_OPTIONS:''}
 *     (architecture §8 decision 39, see `scrubbedSpawnEnv` in
 *     `dry-run.ts`). The script and the loaded recipe therefore
 *     CANNOT read parent secrets (AUTH_SECRET,
 *     GITHUB_CLIENT_SECRET, DATABASE_URL, ...) via `process.env`.
 *     A regression test in `dry-run.test.ts` proves the negative
 *     property.
 *   - (child_process and inspector are NOT allowed — Node 24 default)
 *   - The script's read scope is restricted; any attempt to read
 *     outside the allow list (canary file, registry secrets, etc.)
 *     surfaces as ERR_ACCESS_DENIED and the script reports it on
 *     stdout as { success: false, error: "ERR_ACCESS_DENIED: ..." }.
 *     The parent treats that as a `failed` per-recipe result.
 */
export const DRY_RUN_SCRIPT = String.raw`
'use strict'

const fs = require('node:fs')
const path = require('node:path')

function argValue(name) {
  // With "node -e <script> -- <args>", the "--" separator is
  // consumed by node and the script args start at argv[1]. The
  // [eval] placeholder that appears in -e mode in some runtimes
  // is absent in our invocation, so slice(1) is the correct
  // offset - slice(2) would silently drop the first arg
  // (--recipe-id).
  const argv = process.argv.slice(1)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) {
      const v = argv[i + 1]
      if (v === undefined) return null
      return v
    }
  }
  return null
}

function emit(result) {
  process.stdout.write(JSON.stringify(result) + '\n')
}

async function main() {
  process.stderr.write('[dryrun-script] entered main\n')
  process.stderr.write('[dryrun-script] argv=' + JSON.stringify(process.argv) + '\n')
  const recipeId = argValue('--recipe-id')
  const packDir = argValue('--pack-dir')
  const sandboxDir = argValue('--sandbox-dir')
  const jitiRoot = argValue('--jiti-root') || packDir
  const mode = argValue('--mode') || 'execute'
  process.stderr.write('[dryrun-script] parsed: recipeId=' + recipeId + ' packDir=' + packDir + ' sandboxDir=' + sandboxDir + ' jitiRoot=' + jitiRoot + ' mode=' + mode + '\n')

  if (!recipeId || !packDir || !sandboxDir) {
    emit({ success: false, error: 'dry-run subprocess: missing --recipe-id, --pack-dir, or --sandbox-dir' })
    process.exit(1)
  }

  // Optional test-only canary channel (architecture section 8
  // decision 39). The parent passes the config as
  // --canary-config <json> only when its own process has
  // BAKA_DRYRUN_TEST_CANARY_CONFIG set. The decoded JSON is
  // written verbatim to <sandboxDir>/_canary.json BEFORE chdir so
  // the recipe body can read it via readFileSync of that name.
  // Writing the file inside the sandbox keeps it on the read+write
  // allow lists without expanding the subprocess permitted read
  // scope. Bad JSON is reported as a hard failure (script exits
  // 1) so the parent per-recipe row carries an honest error
  // rather than silently dropping the channel.
  const canaryConfigArg = argValue('--canary-config')
  if (canaryConfigArg !== null) {
    let parsed
    try {
      parsed = JSON.parse(canaryConfigArg)
    } catch (err) {
      const msg = err && err.message ? err.message : String(err)
      emit({ success: false, error: 'canary config is not valid JSON: ' + msg })
      process.exit(1)
    }
    try {
      fs.writeFileSync(path.join(sandboxDir, '_canary.json'), JSON.stringify(parsed), 'utf8')
    } catch (err) {
      const msg = err && err.message ? err.message : String(err)
      emit({ success: false, error: 'canary config write failed: ' + msg })
      process.exit(1)
    }
  }

  // Anchor the cwd in the sandbox so any relative path the recipe
  // resolves (e.g. writeFileSync('scaffold/foo.txt', ...)) lands
  // inside the write scope, not in the worker's cwd or the pack
  // dir. We chdir AFTER resolving argv but BEFORE the jiti load -
  // jiti does not depend on cwd, so the order is safe.
  try {
    process.chdir(sandboxDir)
    process.stderr.write('[dryrun-script] chdir OK cwd=' + process.cwd() + '\n')
  } catch (err) {
    process.stderr.write('[dryrun-script] chdir FAILED: ' + err.message + '\n')
    emit({ success: false, error: 'chdir failed: ' + (err && err.message ? err.message : String(err)) })
    process.exit(1)
  }
  process.stderr.write('[dryrun-script] before jiti load\n')

  // Load the recipe via jiti. The cwd for resolution is the
  // jiti-root (the registry install root in production, the workspace
  // root in dev/test) so that workspace imports like 'baka-sdk' and
  // '@repo/protocol' resolve correctly. The recipe's own relative
  // imports resolve from the pack dir regardless.
  process.stderr.write('[dryrun-script] before require jiti\n')
  let jiti
  try {
    jiti = require('jiti')(jitiRoot, { interopDefault: true })
    process.stderr.write('[dryrun-script] after require jiti, typeof=' + typeof jiti + '\n')
  } catch (err) {
    process.stderr.write('[dryrun-script] jiti require threw: ' + (err && err.stack ? err.stack : String(err)) + '\n')
    emit({ success: false, error: 'jiti load failed: ' + (err && err.message ? err.message : String(err)) })
    process.exit(1)
  }

  // SENTINEL RENDER MODE (architecture §4.6 layer 2, VAL-SCAN-005
  // conditional clause): walk <packDir>/<recipeId>/templates/
  // for Handlebars files carrying the {{!-- no-llm --}} sentinel
  // comment, render each with the empty fixture params context
  // (matching what the non-reasoning recipe branch would call
  // step.execute with), write the rendered bytes to the sandbox.
  // Mirror the engine-side semantics
  // (packages/ast-tooling/src/worker.ts:24):
  //   - key = templatesDir-relative path with .hbs /
  //     .handlebars extension stripped, forward-slashes only.
  //   - render = Handlebars.compile(content)(input.parameters),
  //     where input.parameters is {} (the dry-run's empty
  //     fixture context, matching non-reasoning recipes).
  // The renderer runs in this same subprocess so the env scrub
  // (decision 39: PATH / HOME / TMPDIR / NODE_OPTIONS:''), the
  // --allow-fs-write (sandbox-only), and the read-allow list
  // (pack root + sandbox + jiti root) all apply.
if (mode === "render-sentinel") {
	const NO_LLM_SENTINEL = /\{\{!--\s*no-llm\s*--\}\}/
	const HandlebarsMod = jiti("handlebars")
	// jiti's interop wrapping can place the CJS export on either
	// the pack object itself or its default-export field; pick
	// the one that exposes compile().
	const Handlebars =
		HandlebarsMod && typeof HandlebarsMod.compile === "function"
			? HandlebarsMod
			: HandlebarsMod && HandlebarsMod.default
	if (!Handlebars || typeof Handlebars.compile !== "function") {
		emit({ success: false, error: "handlebars load failed in render-sentinel mode" })
		process.exit(1)
	}

const templatesDir = path.join(packDir, recipeId, "templates")
let written = 0
if (fs.existsSync(templatesDir)) {
	try {
		walkRenderTemplates(templatesDir, "", templatesDir, Handlebars, NO_LLM_SENTINEL)
		written = walkRenderTemplatesCount
	} catch (err) {
		const msg = err && err.message ? err.message : String(err)
		emit({ success: false, error: "sentinel render failed: " + msg })
		process.exit(1)
	}
}
process.stderr.write("[dryrun-script] render-sentinel wrote " + written + " template(s)\n")

// Walk the sandbox to surface what was written. Mirrors the
// execute-mode walk below: omit node_modules, dotfiles,
// /out/, and the test-only _canary.json plumbing.
const files = []
try {
	walk(sandboxDir, ".", files)
} catch (err) {
	emit({ success: false, error: "sandbox walk failed: " + (err && err.message ? err.message : String(err)) })
	process.exit(1)
}
emit({ success: true, files: files })
process.exit(0)
}

process.stderr.write("[dryrun-script] before jiti(recipePath)\n")
const recipePath = path.join(packDir, recipeId, "recipe.ts")
let mod
try {
	mod = jiti(recipePath)
	process.stderr.write("[dryrun-script] after jiti load, keys=" + Object.keys(mod || {}).join(",") + "\n")
} catch (err) {
	const msg = err && err.message ? err.message : String(err)
	process.stderr.write("[dryrun-script] jiti(recipePath) threw: " + msg + "\n")
	emit({ success: false, error: "recipe load failed for " + recipeId + ": " + msg })
	process.exit(1)
}

// Resolution order mirrors loadRecipe in recipe-loader.ts:
//   camelCase(id), camelCase(id)+"Recipe", exact id, id+"Recipe", "default".
// The first candidate that exports a WorkflowStep (execute +
// compensate functions) is the winner; the rest are ignored.
const camelCaseId = recipeId.replace(/-([a-z])/g, (_m, c) => c.toUpperCase())
const candidates = [camelCaseId, camelCaseId + "Recipe", recipeId, recipeId + "Recipe", "default"]
let step = null
for (const name of candidates) {
	const c = mod[name]
	if (c && typeof c.execute === "function" && typeof c.compensate === "function") {
		step = c
		break
	}
}
if (!step) {
	emit({
		success: false,
		error: "recipe " + recipeId + " did not resolve to a WorkflowStep (expected one of " + candidates.join(", ") + ")",
	})
	process.exit(1)
}

// Build a minimal OrchestrationState. The recipe's execute()
// receives this as state; targetDirectory points at the sandbox
// so the recipe's filesystem writes land inside the write scope.
// The other fields are the protocol's required schema defaults;
// reasoning-template fill (worker.ts) is bypassed because the
// recipe loader is invoked outside the SAGA here (no LLM provider,
// no rendered templates).
const state = {
	userIntent: "",
	targetDirectory: sandboxDir,
	status: 2, // RUNNING
	executionPlan: { steps: [], currentStepIndex: 0 },
	logs: [],
	artifacts: {},
}

// The RecipeContext a recipe.ts receives (docs/PACKS.md, "The recipe.ts
// contract"). The sandbox is the project root and is empty, and nothing
// outside it is writable, so this is a plain sandbox-confined file API: it
// exists so a pack that writes through ctx.files can be screened at all.
function sandboxFile(p) {
	if (typeof p !== 'string' || p === '' || p.indexOf('\\') !== -1 || p.charAt(0) === '/' || /^[A-Za-z]:/.test(p) || /[\u0000-\u001f]/.test(p)) {
		throw new Error('path "' + p + '" is not a contained relative path')
	}
	const parts = p.split('/').filter((s) => s !== '' && s !== '.')
	if (parts.length === 0 || parts.indexOf('..') !== -1) throw new Error('path "' + p + '" is not a contained relative path')
	return { rel: parts.join('/'), abs: path.join(sandboxDir, ...parts) }
}
const sandboxFiles = {
	exists: (p) => fs.existsSync(sandboxFile(p).abs),
	readText: (p) => fs.readFileSync(sandboxFile(p).abs, 'utf8'),
	write: (p, content) => {
		const f = sandboxFile(p)
		const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
		const existed = fs.existsSync(f.abs)
		fs.mkdirSync(path.dirname(f.abs), { recursive: true })
		fs.writeFileSync(f.abs, bytes)
		return { path: f.rel, op: existed ? 'update' : 'create', contentHash: '' }
	},
	remove: (p) => {
		const f = sandboxFile(p)
		const existed = fs.existsSync(f.abs)
		fs.rmSync(f.abs, { force: true })
		return existed
	},
	own: () => {},
}
const packData = {}
try {
	const dataDir = path.join(packDir, 'data')
	if (fs.existsSync(dataDir)) {
		for (const name of fs.readdirSync(dataDir)) {
			if (name.endsWith('.json')) packData[name.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'))
		}
	}
} catch (err) {
	emit({ success: false, error: 'pack data failed to load: ' + (err && err.message ? err.message : String(err)) })
	process.exit(1)
}
const recipeContext = {
	llmProvider: null,
	pack: { name: path.basename(packDir), version: '0.0.0', root: packDir },
	projectRoot: sandboxDir,
	onExisting: 'skip',
	dryRun: false,
	files: sandboxFiles,
	data: packData,
}

let result
try {
	result = await step.execute({}, state, recipeContext)
} catch (err) {
	// Hard failure inside the recipe's execute(): surface the
	// actual error message verbatim. If the error is the Node
	// ERR_ACCESS_DENIED from --permission, the parent's per-recipe
	// aggregator reports the version as failed and the verdict
	// text quotes the message.
	const msg = err && err.message ? err.message : String(err)
	const code = err && err.code ? err.code + ": " : ""
	emit({ success: false, error: code + msg })
	process.exit(1)
}

// Soft failure (recipe returned { success: false, error: ... }):
// the produced files in the sandbox are still recorded so the
// catalog surface can show what the recipe managed to produce
// before the failure. The verdict text carries the error.
let softError = null
if (result && result.success === false) {
	softError = result.error !== undefined && result.error !== null ? String(result.error) : "recipe reported failure"
}

// Walk the sandbox AFTER execution so we only count newly created
// files. node_modules / dotfiles are skipped (mirrors the static
// scan's filter - keeps the preview list focused on real output).
const files = []
try {
	walk(sandboxDir, ".", files)
} catch (err) {
	emit({ success: false, error: "sandbox walk failed: " + (err && err.message ? err.message : String(err)) })
	process.exit(1)
}

if (softError !== null) {
	emit({ success: false, error: softError, files: files })
	process.exit(0)
}
emit({ success: true, files: files })
process.exit(0)
}

// Counter side-channel so the sentinel render branch above can
// report the number of templates rendered without breaking the
// closure. Updated by walkRenderTemplates; read by the
// render-sentinel branch.
let walkRenderTemplatesCount = 0

// Render every {{!-- no-llm --}}-marked .hbs / .handlebars file
// under cur (rooted at the recipe's templates dir) into the
// sandbox. The function is recursive and includes nested
// subdirectories. rel is the templates-relative POSIX path,
// used as both the file-content key (engine convention) and the
// in-sandbox output path (sandboxDir / rel-without-extension).
function walkRenderTemplates(cur, rel, templatesDir, Handlebars, NO_LLM_SENTINEL) {
	let entries
	try {
		entries = fs.readdirSync(cur, { withFileTypes: true })
	} catch (_err) {
		return
	}
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === "out" || entry.name.startsWith(".")) continue
		const full = path.join(cur, entry.name)
		const r = rel === "" ? entry.name : path.posix.join(rel, entry.name)
		if (entry.isDirectory()) {
			walkRenderTemplates(full, r, templatesDir, Handlebars, NO_LLM_SENTINEL)
			continue
		}
		if (!entry.isFile()) continue
		if (!(entry.name.endsWith(".hbs") || entry.name.endsWith(".handlebars"))) continue
		let content
		try {
			content = fs.readFileSync(full, "utf8")
		} catch (_err) {
			continue
		}
		if (!NO_LLM_SENTINEL.test(content)) continue
		const key = r.replace(/.(hbs|handlebars)$/, "")
		// input.parameters is {} - the dry-run's empty fixture
		// context, mirroring what the engine fills the templates
		// with on the no-LLM path (worker.ts:188).
		let rendered
		try {
			rendered = Handlebars.compile(content)({})
		} catch (err) {
			const msg = err && err.message ? err.message : String(err)
			// Surface the line / column / context Handlebars
			// provided so the verdict text remains useful. A compile
			// error means the template is broken in isolation —
			// render-sentinel mode reports the exact position.
			throw new Error("Handlebars compile failed for " + key + ": " + msg)
		}
		const sandboxBase = process.cwd()
		const outPath = path.join(sandboxBase, key)
		try {
			fs.mkdirSync(path.dirname(outPath), { recursive: true })
			fs.writeFileSync(outPath, rendered)
			walkRenderTemplatesCount++
		} catch (err) {
			const msg = err && err.message ? err.message : String(err)
			// ERR_ACCESS_DENIED surfaces here the same way as the
			// recipe-escape path: the sandbox's --allow-fs-write
			// allow list is sandboxDir, so a path escape attempt (e.g.
			// via a pre-stripped "../foo") bubbles up here with a
			// verbatim message the parent can quote.
			throw new Error("Handlebars write failed for " + key + ": " + msg)
		}
	}
}

function walk(dir, rel, out) {
	let entries
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true })
	} catch (_err) {
		return
	}
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === "out" || entry.name.startsWith(".")) continue
		// The parent may have materialized a test-only canary
		// config as <sandboxDir>/_canary.json BEFORE chdir (see
		// the --canary-config argv handling near the top of
		// main()). The recipe's body can read it via readFileSync
		// but it must NOT show up in the recipe's "produced
		// files" walk — the file is plumbing, not output.
		// Excluding it here keeps layer 2's per-recipe preview
		// surface honest ("files the recipe wrote") and avoids
		// a spurious layer-3 writes-subset-failure when the
		// recipe's declared filePatterns do not name the
		// canary file.
		if (entry.name === "_canary.json") continue
		const full = path.join(dir, entry.name)
		const r = rel === "." ? entry.name : path.posix.join(rel, entry.name)
		if (entry.isDirectory()) {
			walk(full, r, out)
		} else if (entry.isFile()) {
			try {
				const stat = fs.statSync(full)
				out.push({ path: r, size: stat.size })
			} catch (_err) {
				// unreadable / dangling symlink - skip
			}
		} else if (entry.isSymbolicLink()) {
			// Symlinks are skipped: the dry-run is about files the
			// recipe actually wrote, not symlinks the recipe pointed at.
		}
	}
}

main().catch((err) => {
  emit({ success: false, error: 'unhandled: ' + (err && err.message ? err.message : String(err)) })
  process.exit(1)
})
`
