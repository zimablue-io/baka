import type { DesignedRecipe } from "../state"

// ---------------------------------------------------------------------------
// Documentation-file renderers. README.md and PREFERENCES.md. Pure
// functions, no I/O.
// ---------------------------------------------------------------------------

export function renderPreferencesFile(packName: string, prefsBody: string): string {
	const today = new Date().toISOString().slice(0, 10)
	const safeBody = prefsBody.trim() || "_(no preferences synthesized yet)_"
	return `---
pack: ${packName}
generatedAt: ${today}
---

${safeBody}
`
}

export function renderReadmeSource(args: { packName: string; prefs: string; recipes: DesignedRecipe[] }): string {
	const lines: string[] = [
		`# ${args.packName}`,
		``,
		args.prefs.split("\n").slice(1).join("\n").trim() || "Auto-generated pack.",
		``,
		`## Recipes`,
		``,
	]
	for (const a of args.recipes) {
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
