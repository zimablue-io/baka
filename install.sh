#!/bin/sh
# Install the baka CLI from a release tarball, with no clone and no build. Unattended: it asks nothing,
# and it ends on the version handshake, so a script can tell whether the install answers.
#
#   curl -fsSL https://baka.dashboard.zimablue.io/install.sh | sh
#   sh install.sh [--version X.Y.Z] [--base URL] [--tarball PATH_OR_URL] [--prefix DIR] [--mcp] [--quiet]
#
#   --version   the release to install (default: the latest release)
#   --base      where releases are served (default: https://baka.dashboard.zimablue.io, or $BAKA_INSTALL_BASE)
#   --tarball   install this file or URL instead of a release (for a build you made with `pnpm run pack`)
#   --prefix    install under DIR (the binaries land in DIR/bin) instead of npm's global prefix
#   --mcp       also install baka-mcp, the MCP server for agents
#   --quiet     print nothing but errors
#
# A release download is checked against the sha256 in the manifest that sits next to it.
# Exit codes: 0 installed and answering, 2 bad option, missing requirement or failed download, 3 installed but not answering.

set -eu

BASE="${BAKA_INSTALL_BASE:-https://baka.dashboard.zimablue.io}"
version=""
tarball=""
prefix=""
mcp=0
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
		--base) [ $# -ge 2 ] || die "--base needs a value"; BASE="$2"; shift 2 ;;
		--tarball) [ $# -ge 2 ] || die "--tarball needs a value"; tarball="$2"; shift 2 ;;
		--prefix) [ $# -ge 2 ] || die "--prefix needs a value"; prefix="$2"; shift 2 ;;
		--mcp) mcp=1; shift ;;
		--quiet) quiet=1; shift ;;
		-h | --help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) die "unknown option: $1" ;;
	esac
done

command -v node >/dev/null 2>&1 || die "Node.js 24 or later is required, and node is not on the PATH"
command -v npm >/dev/null 2>&1 || die "npm is required, and npm is not on the PATH"
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 24 ] || die "Node.js 24 or later is required; this is $(node --version)"

BASE="${BASE%/}"
work=$(mktemp -d "${TMPDIR:-/tmp}/baka-install.XXXXXX")
trap 'rm -rf "$work"' EXIT

# Download URL to DEST. With "verify", the file must match the sha256 the manifest beside it lists for its name.
download() {
	node --input-type=module -e '
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
const [url, dest, verify] = process.argv.slice(1)
const get = async (u) => {
	const res = await fetch(u)
	if (!res.ok) throw new Error(u + ": HTTP " + res.status)
	return Buffer.from(await res.arrayBuffer())
}
try {
	const body = await get(url)
	if (verify === "verify") {
		const slash = url.lastIndexOf("/")
		const name = url.slice(slash + 1)
		const manifest = JSON.parse((await get(url.slice(0, slash) + "/manifest.json")).toString())
		const entry = manifest.files.find((f) => f.name === name || f.latest === name)
		if (!entry) throw new Error(name + " is not in the release manifest")
		const actual = createHash("sha256").update(body).digest("hex")
		if (actual !== entry.sha256) throw new Error(name + ": sha256 " + actual + " does not match the manifest (" + entry.sha256 + ")")
	}
	writeFileSync(dest, body)
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err))
	process.exit(1)
}
' "$1" "$2" "${3:-}"
}

# Turn a release name (baka-cli) or a custom --tarball value into a local file path, printed on stdout.
fetch_release() {
	name="$1"
	if [ -n "$version" ]; then
		url="$BASE/releases/v$version/$name-$version.tgz"
	else
		url="$BASE/releases/latest/$name.tgz"
	fi
	say "downloading $url" >&2
	download "$url" "$work/$name.tgz" verify || die "could not download $url"
	printf '%s\n' "$work/$name.tgz"
}

if [ -n "$tarball" ]; then
	case "$tarball" in
		http://* | https://*)
			say "downloading $tarball" >&2
			download "$tarball" "$work/custom.tgz" || die "could not download $tarball"
			cli="$work/custom.tgz"
			;;
		*)
			# npm reads a bare relative path as a git spec; a file on disk is named by its absolute path.
			[ -f "$tarball" ] || die "no such file: $tarball"
			cli="$(cd "$(dirname "$tarball")" && pwd)/$(basename "$tarball")"
			;;
	esac
else
	cli=$(fetch_release baka-cli)
fi

targets="$cli"
if [ "$mcp" -eq 1 ]; then
	targets="$targets $(fetch_release baka-mcp)"
fi

say "installing baka"
if [ -n "$prefix" ]; then
	# shellcheck disable=SC2086
	npm install --global --no-audit --no-fund --loglevel=error --prefix "$prefix" $targets || die "npm could not install baka" 2
	bin="$prefix/bin/baka"
else
	# shellcheck disable=SC2086
	npm install --global --no-audit --no-fund --loglevel=error $targets || die "npm could not install baka" 2
	bin="baka"
fi

# The handshake: the same call a host makes before it uses this install.
if ! handshake=$("$bin" version --json 2>&1); then
	die "installed, but \`$bin version --json\` did not answer: $handshake" 3
fi
say "$handshake"
say "baka is installed. Try: baka run add-readme --name my-app"
