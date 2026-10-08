import { existsSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
	dependencies: Record<string, string>
	devDependencies: Record<string, string>
}

describe("@baka/core packaging", () => {
	it("declares what its bundle leaves external as real dependencies", () => {
		const tsup = readFileSync(join(root, "tsup.config.ts"), "utf-8")
		for (const name of ["zod", "handlebars", "jiti"]) {
			expect(tsup).toContain(`"${name}"`)
			expect(pkg.dependencies[name], `${name} must be a dependency`).toBeDefined()
		}
		// Zod 4 generates the JSON Schema itself (`z.toJSONSchema`), so there is no `zod-to-json-schema` alongside it.
		expect(pkg.dependencies["zod-to-json-schema"]).toBeUndefined()
		expect(pkg.dependencies.zod).toMatch(/^\^4\./)
	})

	it("exports the tree hash domain, so a consumer never re-declares the digest prefix", async () => {
		const core = (await import("@baka/core")) as Record<string, unknown>
		expect(core.TREE_HASH_DOMAIN).toBe("workspace.tree.v1")
	})

	it("bundles the private workspace packages instead of depending on them", () => {
		expect(Object.keys(pkg.dependencies).filter((d) => d.startsWith("@repo/") || d.startsWith("@baka/"))).toEqual([])
	})

	// Needs `pnpm build`; the pack-and-install check (scripts/verify-core-pack.mjs) is the end-to-end proof.
	it.skipIf(!existsSync(join(root, "dist", "index.js")))(
		"the built bundle imports only builtins and declared dependencies",
		() => {
			const source = readFileSync(join(root, "dist", "index.js"), "utf-8")
			const specifiers = new Set(
				[...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g)].map(
					(m) => m[1] as string,
				),
			)
			const allowed = new Set([
				...Object.keys(pkg.dependencies),
				...builtinModules,
				...builtinModules.map((m) => `node:${m}`),
			])
			for (const specifier of specifiers) {
				const bare = specifier.startsWith("@")
					? specifier.split("/").slice(0, 2).join("/")
					: (specifier.split("/")[0] as string)
				expect(allowed.has(specifier) || allowed.has(bare), `${specifier} is neither a builtin nor a dependency`).toBe(
					true,
				)
			}
			expect(specifiers.size).toBeGreaterThan(3)
		},
	)
})
