import type { ModuleManifest } from "baka-sdk"

export const Manifest: ModuleManifest = {
	name: "next-base",
	version: "0.1.0",
	description: "Next.js 16 (App Router) project layout. Wraps `npx create-next-app` and pins the project's tsconfig and ESLint to baka-compatible defaults.",
	dependencies: ["baka-base"],
	conflictsWith: [],
	actions: [
		{
			id: "scaffold",
			description: "Create a fresh Next.js 16 project in the target directory. Idempotent.",
			requiresReasoning: false,
			filePatterns: ["package.json", "next.config.ts", "tsconfig.json", "app/layout.tsx", "app/page.tsx"],
			validators: [],
			params: [
				{ name: "name", type: "string", required: true, description: "Project name (kebab-case)." },
				{ name: "tailwind", type: "boolean", required: false, description: "Install Tailwind CSS (default true)." },
				{ name: "srcDir", type: "boolean", required: false, description: "Use a `src/` directory (default true)." },
			],
		},
		{
			id: "add-route",
			description: "Add a new App Router route (app/<segment>/page.tsx) with a default server component.",
			requiresReasoning: false,
			filePatterns: ["app/**/page.tsx"],
			validators: [],
			params: [
				{ name: "path", type: "string", required: true, description: "Route path relative to app/ (e.g. 'dashboard/settings')." },
			],
		},
	],
	moduleValidators: ["nextAppExists", "nextConfigPresent"],
}
