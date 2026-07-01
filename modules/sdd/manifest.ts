import type { ModuleManifest } from "baka-sdk"

export const Manifest: ModuleManifest = {
	name: "sdd",
	version: "0.1.0",
	description:
		"Spec-Driven Development. Generates project constitution (mission, tech-stack, roadmap) and per-feature spec folders (plan, requirements, validation) using LLM reasoning over handlebars templates.",
	dependencies: [],
	conflictsWith: [],
	actions: [
		{
			id: "init-constitution",
			description:
				"Create the project constitution: specs/mission.md, specs/tech-stack.md, specs/roadmap.md. Idempotent. Uses LLM to fill each document from a handlebars prompt.",
			requiresReasoning: true,
			filePatterns: ["specs/mission.md", "specs/tech-stack.md", "specs/roadmap.md"],
			validators: ["constitutionCoherent"],
			params: [
				{
					name: "productName",
					type: "string",
					required: true,
					description: "Name of the product being built.",
				},
				{
					name: "summary",
					type: "string",
					required: true,
					description: "One-paragraph description of what the product does and who it is for.",
				},
				{
					name: "tone",
					type: "string",
					required: false,
					description: "Tone for mission.md (e.g. 'playful', 'serious', 'technical').",
				},
			],
		},
		{
			id: "create-feature",
			description:
				"Create a per-feature spec folder at specs/YYYY-MM-DD-<name>/ containing plan.md, requirements.md, and validation.md. Uses LLM to generate each from a handlebars prompt.",
			requiresReasoning: true,
			filePatterns: ["specs/*/plan.md", "specs/*/requirements.md", "specs/*/validation.md"],
			validators: ["featureSpecCoherent"],
			params: [
				{
					name: "name",
					type: "string",
					required: true,
					description: "Feature name (kebab-case). Creates specs/YYYY-MM-DD-<name>/.",
				},
				{
					name: "description",
					type: "string",
					required: true,
					description: "One-paragraph description of what this feature does and why.",
				},
				{
					name: "context",
					type: "string",
					required: false,
					description: "Optional extra context (e.g. links, prior decisions).",
				},
			],
		},
	],
	moduleValidators: [],
}
