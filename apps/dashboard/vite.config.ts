import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig(({ mode }) => {
	const desktop = mode === "desktop" || Boolean(process.env.TAURI_ENV_PLATFORM)
	return {
		server: {
			host: "127.0.0.1",
			port: 1420,
			strictPort: true,
		},
		preview: {
			host: "127.0.0.1",
			port: 1420,
		},
		resolve: { tsconfigPaths: true },
		...(desktop ? { base: "./" } : {}),
		plugins: [
			tailwindcss(),
			tanstackStart({
				spa: {
					enabled: true,
					prerender: { outputPath: "/index" },
				},
			}),
			viteReact(),
		],
	}
})
