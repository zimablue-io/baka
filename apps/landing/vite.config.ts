import { fileURLToPath, URL } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Shims for node: builtins that the baka protocol barrel pulls in
// transitively (baka-home.ts uses node:os.homedir + node:path.join at
// module load). The landing app never calls bakaHomeDir, but the
// import graph follows the barrel and the runtime throws on the
// raw node: import. These stubs satisfy the bundler with no
// browser-incompatible code.
const nodeOsShim = fileURLToPath(new URL("./src/shims/node-os.ts", import.meta.url))
const nodePathShim = fileURLToPath(new URL("./src/shims/node-path.ts", import.meta.url))

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
			"node:os": nodeOsShim,
			"node:path": nodePathShim,
		},
	},
	server: {
		port: 5173,
	},
})
