/**
 * Sandboxed dry-run subprocess script (architecture §4.6 layer 2).
 *
 * The script is passed to `node --permission -e <SCRIPT>` and is the
 * executor that runs ONE action in an isolated subprocess. The
 * parent (`dry-run.ts`) spawns one subprocess per non-reasoning
 * action and parses the JSON envelope on stdout.
 *
 * Contract with the parent:
 *   argv (after `--` separator):
 *     --action-id  <id>      manifest-declared action id
 *     --module-dir <path>    realpath-resolved module root (read scope)
 *     --sandbox-dir <path>   realpath-resolved empty temp dir (write scope)
 *     --jiti-root <path>     directory jiti uses for resolving
 *                            workspace imports (the registry install
 *                            root, or the workspace root in dev/test)
 *
 *   stdout: a single JSON object per invocation:
 *     { "success": true,  "files": [{ "path": "...", "size": N }, ...] }
 *     { "success": false, "error": "ERR_ACCESS_DENIED: ..." }
 *
 *   exit code:
 *     0 — action ran successfully (the stdout JSON has success: true).
 *         The action's execute() returning { success: false, error: ... }
 *         is treated as a soft failure: the produced files are still
 *         recorded, but the verdict text carries the error and the
 *         preview state becomes 'failed'. The script still exits 0 in
 *         that case so the parent can distinguish a hard load error
 *         (script exits 1) from an action-level soft failure.
 *     1 — hard failure: the action could not be loaded (jiti throw),
 *         the script could not parse its argv, or the filesystem
 *         walk exploded. The error message is on stdout.
 *
 * Sandbox enforcement (parent-side, not the script):
 *   - --allow-fs-read=<module-dir>,<jiti-root>
 *   - --allow-fs-write=<sandbox-dir>
 *   - (child_process and inspector are NOT allowed — Node 24 default)
 *   - The script's read scope is restricted; any attempt to read
 *     outside the allow list (canary file, registry secrets, etc.)
 *     surfaces as ERR_ACCESS_DENIED and the script reports it on
 *     stdout as { success: false, error: "ERR_ACCESS_DENIED: ..." }.
 *     The parent treats that as a `failed` per-action result.
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
  // (--action-id).
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
  const actionId = argValue('--action-id')
  const moduleDir = argValue('--module-dir')
  const sandboxDir = argValue('--sandbox-dir')
  const jitiRoot = argValue('--jiti-root') || moduleDir
  process.stderr.write('[dryrun-script] parsed: actionId=' + actionId + ' moduleDir=' + moduleDir + ' sandboxDir=' + sandboxDir + ' jitiRoot=' + jitiRoot + '\n')

  if (!actionId || !moduleDir || !sandboxDir) {
    emit({ success: false, error: 'dry-run subprocess: missing --action-id, --module-dir, or --sandbox-dir' })
    process.exit(1)
  }

  // Anchor the cwd in the sandbox so any relative path the action
  // resolves (e.g. writeFileSync('scaffold/foo.txt', ...)) lands
  // inside the write scope, not in the worker's cwd or the module
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

  // Load the action via jiti. The cwd for resolution is the
  // jiti-root (the registry install root in production, the workspace
  // root in dev/test) so that workspace imports like 'baka-sdk' and
  // '@repo/protocol' resolve correctly. The action's own relative
  // imports resolve from the module dir regardless.
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

  process.stderr.write('[dryrun-script] before jiti(actionPath)\n')
  const actionPath = path.join(moduleDir, actionId, 'action.ts')
  let mod
  try {
    mod = jiti(actionPath)
    process.stderr.write('[dryrun-script] after jiti load, keys=' + Object.keys(mod || {}).join(',') + '\n')
  } catch (err) {
    const msg = err && err.message ? err.message : String(err)
    process.stderr.write('[dryrun-script] jiti(actionPath) threw: ' + msg + '\n')
    emit({ success: false, error: 'action load failed for ' + actionId + ': ' + msg })
    process.exit(1)
  }

  // Resolution order mirrors loadAction in action-loader.ts:
  //   camelCase(id), camelCase(id)+"Action", exact id, id+"Action", "default".
  // The first candidate that exports a WorkflowStep (execute +
  // compensate functions) is the winner; the rest are ignored.
  const camelCaseId = actionId.replace(/-([a-z])/g, function (_m, c) { return c.toUpperCase() })
  const candidates = [camelCaseId, camelCaseId + 'Action', actionId, actionId + 'Action', 'default']
  let step = null
  for (const name of candidates) {
    const c = mod[name]
    if (c && typeof c.execute === 'function' && typeof c.compensate === 'function') {
      step = c
      break
    }
  }
  if (!step) {
    emit({ success: false, error: 'action ' + actionId + ' did not resolve to a WorkflowStep (expected one of ' + candidates.join(', ') + ')' })
    process.exit(1)
  }

  // Build a minimal OrchestrationState. The action's execute()
  // receives this as state; targetDirectory points at the sandbox
  // so the action's filesystem writes land inside the write scope.
  // The other fields are the protocol's required schema defaults;
  // reasoning-template fill (worker.ts) is bypassed because the
  // action loader is invoked outside the SAGA here (no LLM provider,
  // no rendered templates).
  const state = {
    userIntent: '',
    targetDirectory: sandboxDir,
    status: 2, // RUNNING
    executionPlan: { steps: [], currentStepIndex: 0 },
    logs: [],
    artifacts: {}
  }

  let result
  try {
    result = await step.execute({}, state, { llmProvider: null })
  } catch (err) {
    // Hard failure inside the action's execute(): surface the
    // actual error message verbatim. If the error is the Node
    // ERR_ACCESS_DENIED from --permission, the parent's per-action
    // aggregator reports the version as failed and the verdict
    // text quotes the message.
    const msg = err && err.message ? err.message : String(err)
    const code = err && err.code ? err.code + ': ' : ''
    emit({ success: false, error: code + msg })
    process.exit(1)
  }

  // Soft failure (action returned { success: false, error: ... }):
  // the produced files in the sandbox are still recorded so the
  // catalog surface can show what the action managed to produce
  // before the failure. The verdict text carries the error.
  let softError = null
  if (result && result.success === false) {
    softError = (result.error !== undefined && result.error !== null) ? String(result.error) : 'action reported failure'
  }

  // Walk the sandbox AFTER execution so we only count newly created
  // files. node_modules / dotfiles are skipped (mirrors the static
  // scan's filter - keeps the preview list focused on real output).
  const files = []
  try {
    walk(sandboxDir, '.', files)
  } catch (err) {
    emit({ success: false, error: 'sandbox walk failed: ' + (err && err.message ? err.message : String(err)) })
    process.exit(1)
  }

  if (softError !== null) {
    emit({ success: false, error: softError, files: files })
    process.exit(0)
  }
  emit({ success: true, files: files })
  process.exit(0)
}

function walk(dir, rel, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (_err) {
    return
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'out' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    const r = rel === '.' ? entry.name : path.posix.join(rel, entry.name)
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
      // action actually wrote, not symlinks the action pointed at.
    }
  }
}

main().catch(function (err) {
  emit({ success: false, error: 'unhandled: ' + (err && err.message ? err.message : String(err)) })
  process.exit(1)
})
`
