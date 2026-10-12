/**
 * The small glob dialect of a manifest `marker`: `*` matches within one path
 * segment, `**` matches across segments (`a/**\/b` also matches `a/b`), `?`
 * matches one character, anything else is literal. Patterns match whole
 * project-relative POSIX paths.
 */
function globToRegExp(pattern: string): RegExp {
	const clean = pattern.replace(/^\.\//, "")
	let out = ""
	for (let i = 0; i < clean.length; i++) {
		const ch = clean[i] as string
		if (ch === "*") {
			if (clean[i + 1] === "*") {
				if (clean[i + 2] === "/") {
					out += "(?:.*/)?"
					i += 2
				} else {
					out += ".*"
					i += 1
				}
			} else out += "[^/]*"
		} else if (ch === "?") out += "[^/]"
		else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")
	}
	return new RegExp(`^${out}$`)
}

/** The paths (in input order) that match any of `patterns`. */
export function matchGlobs(paths: readonly string[], patterns: readonly string[]): string[] {
	const res = patterns.map(globToRegExp)
	return paths.filter((path) => res.some((re) => re.test(path)))
}
