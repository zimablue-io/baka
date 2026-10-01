/** Canonical tree hash for experiment runs. Content, not just path lengths. */
export function treeHash(tree: Record<string, string>): string {
	const canonical = Object.keys(tree)
		.sort()
		.map((k) => `${k}\n${tree[k] ?? ""}`)
		.join("\n\n")
	let h = 2166136261
	for (let i = 0; i < canonical.length; i++) {
		h ^= canonical.charCodeAt(i)
		h = Math.imul(h, 16777619)
	}
	return (h >>> 0).toString(16).padStart(8, "0")
}
