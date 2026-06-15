#!/usr/bin/env bash
# baka project init script.
#
# Idempotent. Safe to run multiple times. Called from:
#   1. Root package.json `postinstall` hook (after `pnpm install`)
#   2. Root package.json `setup` script (`pnpm setup`)
#   3. .envrc on direnv enter (when the bin is missing)
#
# What it does:
#   - Verifies pnpm is available
#   - Verifies deps are installed (runs `pnpm install` if node_modules is missing)
#   - Builds the `baka` CLI package so the `bin` field's target file exists
#     (pnpm refuses to symlink `node_modules/.bin/baka` if the target is absent)
#   - Verifies the CLI is now runnable

set -euo pipefail

# Resolve to the directory containing this script, then the repo root.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
cd "$REPO_ROOT"

log()  { printf "  \033[36m==>\033[0m %s\n" "$*"; }
ok()   { printf "  \033[32m✓\033[0m  %s\n" "$*"; }
warn() { printf "  \033[33m!\033[0m  %s\n" "$*" >&2; }
fail() { printf "  \033[31m✗\033[0m  %s\n" "$*" >&2; exit 1; }

# 1. pnpm available?
if ! command -v pnpm >/dev/null 2>&1; then
	fail "pnpm not found. Install via: npm install -g pnpm (engine requires >=8)"
fi
PNPM_VERSION="$(pnpm --version)"
ok "pnpm ${PNPM_VERSION}"

# 2. deps installed?
# Skip this check if we're being called from pnpm's `postinstall` hook
# (running `pnpm install` from inside `postinstall` causes infinite recursion).
if [ -z "${BAKA_SETUP_SKIP_INSTALL:-}" ]; then
	if [ ! -d "node_modules" ] || [ ! -d "node_modules/.pnpm" ]; then
		log "running pnpm install (node_modules missing)"
		pnpm install --silent
	fi
	ok "deps installed"
else
	log "deps check skipped (BAKA_SETUP_SKIP_INSTALL set, running under pnpm postinstall)"
fi

# 3. CLI bin target exists? Build if not.
CLI_DIST="$REPO_ROOT/apps/cli/dist/index.js"
if [ ! -f "$CLI_DIST" ]; then
	log "building @baka/cli (bin target missing)"
	pnpm --filter baka run build --silent
fi
if [ ! -f "$CLI_DIST" ]; then
	fail "build did not produce $CLI_DIST"
fi
ok "baka CLI built at apps/cli/dist/index.js"

# 4. symlink in node_modules/.bin?
# pnpm sometimes refuses to link workspace bins when the target file didn't
# exist at install time. We work around that by creating the symlink manually
# when needed. The setup script is idempotent.
if [ ! -e "node_modules/.bin/baka" ]; then
	if [ -z "${BAKA_SETUP_SKIP_INSTALL:-}" ]; then
		warn "node_modules/.bin/baka missing; re-linking workspace"
		pnpm install --silent
	fi
	if [ ! -e "node_modules/.bin/baka" ]; then
		log "pnpm did not link the bin (known workspace-bin quirk); creating symlink manually"
		mkdir -p node_modules/.bin
		ln -sf "$PWD/apps/cli/dist/index.js" node_modules/.bin/baka
	fi
fi
if [ ! -e "node_modules/.bin/baka" ]; then
	fail "node_modules/.bin/baka still missing; cannot create symlink."
fi
ok "node_modules/.bin/baka symlink present"

# 5. MCP server bin target exists? Build if not.
MCP_DIST="$REPO_ROOT/apps/mcp/dist/index.js"
if [ ! -f "$MCP_DIST" ]; then
	log "building @baka/mcp-server (bin target missing)"
	pnpm --filter @baka/mcp-server build --silent
fi
if [ ! -f "$MCP_DIST" ]; then
	fail "build did not produce $MCP_DIST"
fi
ok "baka-mcp built at apps/mcp/dist/index.js"

# 6. symlink in node_modules/.bin?
if [ ! -e "node_modules/.bin/baka-mcp" ]; then
	if [ -z "${BAKA_SETUP_SKIP_INSTALL:-}" ]; then
		warn "node_modules/.bin/baka-mcp missing; re-linking workspace"
		pnpm install --silent
	fi
	if [ ! -e "node_modules/.bin/baka-mcp" ]; then
		log "pnpm did not link the bin (known workspace-bin quirk); creating symlink manually"
		mkdir -p node_modules/.bin
		ln -sf "$PWD/apps/mcp/dist/index.js" node_modules/.bin/baka-mcp
	fi
fi
if [ ! -e "node_modules/.bin/baka-mcp" ]; then
	fail "node_modules/.bin/baka-mcp still missing; cannot create symlink."
fi
ok "node_modules/.bin/baka-mcp symlink present"

# 7. MCP server runnable? (file present and shebang is valid node)
MCP_BIN="$REPO_ROOT/node_modules/.bin/baka-mcp"
if [ -x "$MCP_BIN" ] && head -1 "$MCP_BIN" | grep -q "^#!/usr/bin/env node"; then
	ok "baka-mcp is runnable (stdio JSON-RPC server)"
else
	warn "baka-mcp symlink exists but is not an executable node script; runtime calls may fail"
fi

# 8. CLI runnable?
if "$REPO_ROOT/node_modules/.bin/baka" --version >/dev/null 2>&1; then
	VERSION="$("$REPO_ROOT/node_modules/.bin/baka" --version)"
	ok "baka ${VERSION} is runnable"
else
	warn "baka --version failed; the CLI may be missing runtime deps"
	"$REPO_ROOT/node_modules/.bin/baka" --version || true
fi

printf "\n  \033[32mbaka is ready.\033[0m Try:  baka --help\n\n"
