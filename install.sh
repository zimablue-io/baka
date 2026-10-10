#!/bin/sh
# Install the baka CLI from a release tarball, with no clone and no build. Unattended: it asks nothing,
# and it ends on the version handshake, so a script can tell whether the install answers.
#
#   sh install.sh [--version X.Y.Z] [--tarball PATH_OR_URL] [--prefix DIR] [--quiet]
#
#   --version   the release to install (default: the latest release)
#   --tarball   install this file or URL instead of a release (for a build you made with `pnpm pack`)
#   --prefix    install under DIR (the binary lands in DIR/bin) instead of npm's global prefix
#   --quiet     print nothing but errors
#
# Exit codes: 0 installed and answering, 2 bad option or missing requirement, 3 installed but not answering.

set -eu

REPO="zimablue-io/baka"
version=""
tarball=""
prefix=""
quiet=0

die() {
	printf 'baka install: %s\n' "$1" >&2
	exit "${2:-2}"
}

say() {
	[ "$quiet" -eq 1 ] || printf '%s\n' "$1"
}

while [ $# -gt 0 ]; do
	case "$1" in
		--version) [ $# -ge 2 ] || die "--version needs a value"; version="$2"; shift 2 ;;
		--tarball) [ $# -ge 2 ] || die "--tarball needs a value"; tarball="$2"; shift 2 ;;
		--prefix) [ $# -ge 2 ] || die "--prefix needs a value"; prefix="$2"; shift 2 ;;
		--quiet) quiet=1; shift ;;
		-h | --help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) die "unknown option: $1" ;;
	esac
done

command -v node >/dev/null 2>&1 || die "Node.js 20 or later is required, and node is not on the PATH"
command -v npm >/dev/null 2>&1 || die "npm is required, and npm is not on the PATH"
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 20 ] || die "Node.js 20 or later is required; this is $(node --version)"

if [ -z "$tarball" ]; then
	if [ -n "$version" ]; then
		tarball="https://github.com/$REPO/releases/download/v$version/baka-$version.tgz"
	else
		tarball="https://github.com/$REPO/releases/latest/download/baka.tgz"
	fi
fi

# npm reads a bare relative path as a git spec; a file on disk is named by its absolute path.
if [ -f "$tarball" ]; then tarball="$(cd "$(dirname "$tarball")" && pwd)/$(basename "$tarball")"; fi
say "installing baka from $tarball"
if [ -n "$prefix" ]; then
	npm install --global --no-audit --no-fund --loglevel=error --prefix "$prefix" "$tarball" || die "npm could not install $tarball" 2
	bin="$prefix/bin/baka"
else
	npm install --global --no-audit --no-fund --loglevel=error "$tarball" || die "npm could not install $tarball" 2
	bin="baka"
fi

# The handshake: the same call a host makes before it uses this install.
if ! handshake=$("$bin" version --json 2>&1); then
	die "installed, but \`$bin version --json\` did not answer: $handshake" 3
fi
say "$handshake"
say "baka is installed. Try: baka run add-readme --name my-app"
