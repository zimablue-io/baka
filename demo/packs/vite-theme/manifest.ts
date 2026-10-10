import type { PackManifest } from "baka-sdk"

export const Manifest: PackManifest = {
	name: "vite-theme",
	version: "0.1.0",
	description: "Writes src/styles.css for the Vite app (colors, type).",
	dependencies: [],
	conflictsWith: [],
	recipes: [
		{
			id: "write",
			description: "Write src/styles.css from color and type params.",
			requiresReasoning: false,
			filePatterns: ["src/styles.css"],
			validators: [],
			params: [
				{
					name: "accent",
					type: "string",
					required: true,
					description: "hex or CSS color for links and highlights",
				},
				{
					name: "background",
					type: "string",
					required: true,
					description: "page background",
				},
				{
					name: "ink",
					type: "string",
					required: true,
					description: "body text color",
				},
				{
					name: "font",
					type: "string",
					required: true,
					description: "CSS font-family stack",
				},
			],
		},
	],
	packValidators: [],
}
