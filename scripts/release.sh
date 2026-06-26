#!/usr/bin/env bash
# scripts/release.sh
#
# Bump the project version, build the dist artifacts, and pack both
# installable tarballs. The script does NOT publish. Publishing is a
# separate manual step documented in docs/PUBLISHING.md.
#
# Validation contract pins:
#   VAL-PKG-020  bumps root + apps/cli + apps/mcp package.json consistently
#   VAL-PKG-021  refuses to run on a dirty tree
#   VAL-PKG-022  --dry-run prints the plan without mutating
#   VAL-PKG-023  no functional publish references; only this comment mentions publish
#   VAL-CROSS-005  cross-area versioning round-trip (release -> pack -> install)
#   VAL-CROSS-014  dirty-tree guard fires before any mutation
#
# This script NEVER invokes `pnpm publish`. There is no --publish flag.
# Any --publish argument is treated as an unknown flag and exits 1.

set -euo pipefail

print_help() {
	cat <<EOF
usage: scripts/release.sh [--dry-run] <version>

Bump the version in root package.json, apps/cli/package.json, and
apps/mcp/package.json to <version> (semver, e.g. 1.2.3 or 1.2.3-rc.1).
Then run \`pnpm pack\` to write installable tarballs to dist-tarballs/.
Then print the global-install command.

Options:
  --dry-run   Print the planned diff and the planned commands without
              mutating any file or running pack.

Exit codes:
  0  success (or successful dry-run plan)
  1  invalid arguments, dirty tree, or pack failure
  2  invalid version format

This script does not publish. The npm switch is documented in
docs/PUBLISHING.md and is intentionally a separate manual step.
EOF
}

DRY_RUN=false
VERSION=""

for arg in "$@"; do
	case "$arg" in
		-h|--help)
			print_help
			exit 0
			;;
		--dry-run)
			DRY_RUN=true
			;;
		-*)
			printf "unknown flag: %s\n\n" "$arg" >&2
			print_help >&2
			exit 1
			;;
		*)
			VERSION="$arg"
			;;
	esac
done

if [ -z "$VERSION" ]; then
	printf "missing required argument: <version>\n\n" >&2
	print_help >&2
	exit 1
fi

# Semver: MAJOR.MINOR.PATCH with optional pre-release suffix.
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
	printf "invalid version: %s (expected semver, e.g. 1.2.3 or 1.2.3-rc.1)\n" "$VERSION" >&2
	exit 2
fi

# Resolve to repo root. This script lives at scripts/release.sh.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
cd "$REPO_ROOT"

# Dirty-tree guard (VAL-PKG-021, VAL-CROSS-014). Must fire BEFORE any
# mutation so a dirty run cannot leave the tree half-updated.
if [ -n "$(git status --porcelain)" ]; then
	printf "refusing to release on a dirty tree:\n\n" >&2
	git status --porcelain | head -n 20 >&2 || true
	printf "\ncommit or stash the uncommitted changes and try again.\n" >&2
	exit 1
fi

PKG_FILES=(
	package.json
	apps/cli/package.json
	apps/mcp/package.json
)

CURRENT_ROOT_VERSION="$(jq -r .version package.json)"

if [ "$DRY_RUN" = true ]; then
	printf "=== release plan (dry run) ===\n"
	printf "  repo root: %s\n" "$REPO_ROOT"
	printf "  version:   %s -> %s\n\n" "$CURRENT_ROOT_VERSION" "$VERSION"

	for f in "${PKG_FILES[@]}"; do
		CUR="$(jq -r .version "$f")"
		if [ "$CUR" = "$VERSION" ]; then
			printf "  %s: already at %s (no change)\n" "$f" "$CUR"
		else
			printf "  %s: %s -> %s\n" "$f" "$CUR" "$VERSION"
		fi
	done

	printf "\n=== would run ===\n"
	printf "  pnpm --filter baka build\n"
	printf "  pnpm --filter @baka/mcp-server build\n"
	printf "  pnpm pack\n"

	printf "\n=== install command (after the real run) ===\n"
	printf "  pnpm install -g %s/baka-%s.tgz %s/@baka-mcp-server-%s.tgz\n" \
		"$REPO_ROOT" "$VERSION" "$REPO_ROOT" "$VERSION"

	printf "\nthis was a dry run; no files were changed and no tarballs were built.\n"
	printf "next: scripts/release.sh %s to apply the bump and build the tarballs.\n" "$VERSION"
	exit 0
fi

# Apply the bump to all three package.json files. jq rewrites atomically
# through a temp file + mv so a crash mid-write cannot corrupt the source.
for f in "${PKG_FILES[@]}"; do
	TMP="$(mktemp)"
	if jq --arg v "$VERSION" '.version = $v' "$f" > "$TMP"; then
		mv "$TMP" "$f"
		printf "bumped %s to %s\n" "$f" "$VERSION"
	else
		rm -f "$TMP"
		printf "failed to update %s\n" "$f" >&2
		exit 1
	fi
done

# Build both dist artifacts so pack has something to ship.
printf "\n=== building dist artifacts ===\n"
pnpm --filter baka build
pnpm --filter @baka/mcp-server build

# Pack both workspaces via the canonical scripts/pack.mjs wrapper.
printf "\n=== packing tarballs ===\n"
pnpm pack

# Print the install command and a pointer to the publish step.
printf "\n=== install command ===\n"
printf "  pnpm install -g %s/baka-%s.tgz %s/@baka-mcp-server-%s.tgz\n" \
	"$REPO_ROOT" "$VERSION" "$REPO_ROOT" "$VERSION"

printf "\ntarballs written to %s/dist-tarballs/.\n" "$REPO_ROOT"
printf "next step: review the tarballs, then follow docs/PUBLISHING.md.\n"
