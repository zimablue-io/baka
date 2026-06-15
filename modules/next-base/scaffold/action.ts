import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { StepResponse, WorkflowStep, OrchestrationState } from "baka-sdk"
import { AgentRole } from "baka-sdk"

export interface ScaffoldInput {
	name: string
	tailwind?: boolean
	srcDir?: boolean
}

export interface ScaffoldCompensationData {
	targetDirectory: string
	createdFiles: string[]
}

export const scaffoldAction: WorkflowStep<ScaffoldInput, boolean, ScaffoldCompensationData> = {
	name: "next-base.scaffold",
	role: AgentRole.WORKER,

	execute: async (input, state): Promise<StepResponse<boolean, ScaffoldCompensationData>> => {
		const target = state.targetDirectory
		const tailwind = input.tailwind ?? true
		const srcDir = input.srcDir ?? true
		const created: string[] = []
		try {
			if (!/^[a-z0-9-_]+$/.test(input.name)) {
				throw new Error(`project name must be kebab-case: ${input.name}`)
			}

			const write = (rel: string, content: string) => {
				const full = join(target, rel)
				mkdirSync(join(full, ".."), { recursive: true })
				writeFileSync(full, content, "utf-8")
				created.push(full)
			}

			const ensure = (rel: string, content: string) => {
				const full = join(target, rel)
				if (existsSync(full)) return
				write(rel, content)
			}

			ensure("package.json", renderPackageJson(input.name))
			ensure("next.config.ts", renderNextConfig())
			ensure("tsconfig.json", renderTsConfig(srcDir))
			ensure(join(srcDir ? "src/app" : "app", "layout.tsx"), renderLayout())
			ensure(join(srcDir ? "src/app" : "app", "page.tsx"), renderPage(input.name))
			ensure(join(srcDir ? "src/app" : "app", "globals.css"), renderGlobalsCss(tailwind))
			ensure("README.md", renderReadme(input.name))
			ensure(".gitignore", renderGitignore())

			if (tailwind) {
				ensure("postcss.config.mjs", renderPostCssConfig())
				ensure("tailwind.config.ts", renderTailwindConfig())
			}

			return {
				success: true,
				output: true,
				compensationData: { targetDirectory: target, createdFiles: created },
			}
		} catch (err) {
			return {
				success: false,
				output: false,
				compensationData: { targetDirectory: target, createdFiles: created },
				error: err instanceof Error ? err.message : String(err),
			}
		}
	},

	compensate: async (data, _state): Promise<void> => {
		const { rmSync } = require("node:fs") as typeof import("node:fs")
		for (const file of data.createdFiles) {
			try {
				rmSync(file, { force: true })
			} catch {
				/* best effort */
			}
		}
	},
}

function renderPackageJson(name: string): string {
	return JSON.stringify(
		{
			name,
			version: "0.1.0",
			private: true,
			scripts: {
				dev: "next dev",
				build: "next build",
				start: "next start",
				lint: "next lint",
			},
			dependencies: { next: "^16.0.0", react: "^19.0.0", "react-dom": "^19.0.0" },
			devDependencies: { "@types/node": "^22.0.0", "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0", typescript: "^5.9.0" },
		},
		null,
		"\t",
	) + "\n"
}

function renderNextConfig(): string {
	return `import type { NextConfig } from "next"

const nextConfig: NextConfig = {
	reactStrictMode: true,
}

export default nextConfig
`
}

function renderTsConfig(srcDir: boolean): string {
	return JSON.stringify(
		{
			compilerOptions: {
				target: "ES2022",
				lib: ["dom", "dom.iterable", "ES2022"],
				module: "ESNext",
				moduleResolution: "Bundler",
				jsx: "preserve",
				allowJs: true,
				esModuleInterop: true,
				skipLibCheck: true,
				strict: true,
				noEmit: true,
				incremental: true,
				isolatedModules: true,
				plugins: [{ name: "next" }],
				paths: { "@/*": ["./src/*"] },
			},
			include: ["next-env.d.ts", srcDir ? "src/**/*.ts" : "**/*.ts", srcDir ? "src/**/*.tsx" : "**/*.ts", ".next/types/**/*.ts"],
			exclude: ["node_modules"],
		},
		null,
		"\t",
	) + "\n"
}

function renderLayout(): string {
	return `import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
	title: "baka app",
	description: "scaffolded by baka",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	)
}
`
}

function renderPage(name: string): string {
	return `export default function HomePage() {
	return (
		<main>
			<h1>hello from ${name}</h1>
			<p>scaffolded by baka</p>
		</main>
	)
}
`
}

function renderGlobalsCss(tailwind: boolean): string {
	if (!tailwind) return `/* global styles */\n`
	return `@import "tailwindcss";\n\n:root { color-scheme: light dark; }\n`
}

function renderReadme(name: string): string {
	return `# ${name}

Next.js 16 (App Router) project scaffolded by baka.

## Scripts

- \`pnpm dev\` — start the dev server
- \`pnpm build\` — build for production
- \`pnpm start\` — serve the production build
`
}

function renderGitignore(): string {
	return `node_modules/
.next/
out/
*.log
.DS_Store
.env*.local
`
}

function renderPostCssConfig(): string {
	return `export default { plugins: { "@tailwindcss/postcss": {} } }
`
}

function renderTailwindConfig(): string {
	return `import type { Config } from "tailwindcss"

const config: Config = {
	content: ["./src/**/*.{ts,tsx}"],
	theme: { extend: {} },
	plugins: [],
}

export default config
`
}
