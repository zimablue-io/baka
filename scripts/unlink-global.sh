#!/usr/bin/env bash
# scripts/unlink-global.sh
#
# Idempotently remove the global `baka` and `baka-mcp` shims, regardless
# of which pnpm version (or install method) created them. Used by:
#   1. The PRE-FLIGHT step in the M4 user-testing flow.
#   2. The README's uninstall section.
#   3. The VAL-CROSS-008 uninstall round-trip validator.
#
# pnpm version matrix (the dance that motivated this script):
#   - pnpm 9.x: install = `pnpm install -g <tgz>`, unlink = `pnpm unlink --global <pkg>`
#   - pnpm 10.x: install = `pnpm install -g <tgz>`, unlink = `pnpm uninstall -g <pkg>` (no --global flag for unlink; -g is implicit)
#   - pnpm 9 and pnpm 10 use different content-addressable stores (v3 vs v10),
#     so `pnpm unlink` from one cannot see `pnpm install -g` from the other.
#
# This script tries both, and falls back to deleting the shim files directly
# (the user's own PRE-FLIGHT in the task description does this for the same
# reason). Idempotent: safe to re-run.

set -euo pipefail

# Args: optional package list. Defaults to both baka and baka-mcp.
PKGS=()
print_help() {
  cat <<EOF
usage: scripts/unlink-global.sh [pkg ...]

Removes the global shim for each given package. Defaults to "baka" and
"@baka/mcp-server". Tries \`pnpm unlink --global <pkg>\` first, then
\`pnpm uninstall -g <pkg>\`, then deletes the shim file as a last resort.

Idempotent. Safe to run multiple times.
EOF
}

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      PKGS+=("$arg")
      ;;
  esac
done

if [ ${#PKGS[@]} -eq 0 ]; then
  PKGS=("baka" "@baka/mcp-server")
fi

# Resolve the global bin dir from `pnpm root -g`.
PNPM_BIN_DIR="$(pnpm root -g 2>/dev/null | xargs dirname 2>/dev/null || true)"

# Common global bin dirs (macOS/Linux). Cover Homebrew pnpm, corepack pnpm,
# and `pnpm config set global-bin-dir <path>` overrides.
CANDIDATE_BIN_DIRS=(
  "/Users/lefamoffat/Library/pnpm"
  "$HOME/Library/pnpm"
  "/usr/local/bin"
  "/opt/homebrew/bin"
  "$HOME/.local/share/pnpm"
  "$HOME/.pnpm"
)
if [ -n "$PNPM_BIN_DIR" ] && [ "$PNPM_BIN_DIR" != "$HOME" ]; then
  CANDIDATE_BIN_DIRS+=("$PNPM_BIN_DIR")
fi

# Map a package name to its bin shim name.
bin_name_for() {
  case "$1" in
    baka) echo "baka" ;;
    @baka/mcp-server) echo "baka-mcp" ;;
    *) echo "${1#@}" ;;
  esac
}

# Try the modern (pnpm 10) syntax first; pnpm 9 users get a graceful no-op.
try_pnpm_uninstall() {
  local pkg="$1"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm uninstall -g "$pkg" >/dev/null 2>&1 || true
  fi
}

# Try the legacy (pnpm 9) syntax; silently no-op on pnpm 10.
try_pnpm_unlink_global() {
  local pkg="$1"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm unlink --global "$pkg" >/dev/null 2>&1 || true
  fi
}

# Last resort: delete the shim file from every candidate dir.
delete_shim_files() {
  local bin_name="$1"
  for dir in "${CANDIDATE_BIN_DIRS[@]}"; do
    [ -n "$dir" ] || continue
    [ -e "$dir/$bin_name" ] && rm -f "$dir/$bin_name" || true
  done
}

for pkg in "${PKGS[@]}"; do
  bin_name="$(bin_name_for "$pkg")"
  try_pnpm_uninstall "$pkg"
  try_pnpm_unlink_global "$pkg"
  delete_shim_files "$bin_name"
done
