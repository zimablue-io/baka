import type { DesignedAction } from "../state"

// ---------------------------------------------------------------------------
// Documentation-file renderers. README.md and PREFERENCES.md. Pure
// functions, no I/O.
// ---------------------------------------------------------------------------

export function renderPreferencesFile(moduleName: string, prefsBody: string): string {
	const today = new Date().toISOString().slice(0, 10)
	const safeBody = prefsBody.trim() || "_(no preferences synthesized yet)_"
	return `---
module: ${moduleName}
generatedAt: ${today}
---

${safeBody}
`
}

export function renderReadmeSource(args: { moduleName: string; prefs: string; actions: DesignedAction[] }): string {
	const lines: string[] = [
		`# ${args.moduleName}`,
		``,
		args.prefs.split("\n").slice(1).join("\n").trim() || "Auto-generated module.",
		``,
		`## Actions`,
		``,
	]
	for (const a of args.actions) {
		lines.push(`### \`${a.id}\``)
		lines.push(``)
		lines.push(a.description)
		lines.push(``)
		if (a.requiresReasoning) lines.push(`**Requires LLM assist.**`)
		if (a.compensatesWith) lines.push(`**Inverse:** \`${a.compensatesWith}\``)
		if (a.params.length > 0) {
			lines.push(``)
			lines.push(`**Parameters:**`)
			lines.push(``)
			for (const p of a.params) {
				lines.push(`- \`${p.name}\` (${p.type}${p.required ? "" : ", optional"}): ${p.description}`)
			}
		}
		lines.push(``)
	}
	return lines.join("\n")
}
