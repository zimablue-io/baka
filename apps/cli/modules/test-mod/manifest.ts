import type { ModuleManifest } from "@repo/protocol"

export const Manifest: ModuleManifest = {
	name: "test-mod",
	version: "1.0.0",
	dependencies: [],
	actions: [
		{
			id: "init",
			description: "Default boilerplate initialization routine for test-mod",
			params: [],
		},
	],
}
