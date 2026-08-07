// Browser shim for `node:os`. The baka protocol package re-exports
// `bakaHomeDir` from its barrel; that function calls `homedir()` at
// module load. The landing app never calls the function, but the
// import graph is followed at bundle time and the runtime throws.
// Replacing `node:os` with an empty stub lets Vite resolve the
// import without bundling any browser-incompatible code.

export function homedir(): string {
	return ""
}

const defaultOs = { homedir }
export default defaultOs
