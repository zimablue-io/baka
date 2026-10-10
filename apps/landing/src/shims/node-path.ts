// Browser shim for `node:path`. Pairs with the `node:os` shim — the
// protocol barrel imports `join` from this pack at module load.
// The landing app never invokes path helpers at runtime; the stubs
// exist only to satisfy the bundler.

export function join(...parts: string[]): string {
	return parts.join("/")
}

const defaultPath = { join }
export default defaultPath
