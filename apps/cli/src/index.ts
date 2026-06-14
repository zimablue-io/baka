#!/usr/bin/env node
import * as fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { discoverModules } from "@repo/discovery-workflow"
import { featurePlanningWorkflow } from "@repo/feature-planning-workflow"
import { executeCreateModuleWorkflow } from "@repo/module-management-workflow"
import { Command } from "commander"

const program = new Command()

// Helper to find the monorepo root (where package.json exists)
function findMonorepoRoot(startDir: string): string {
	let currentDir = startDir
	while (currentDir !== path.parse(currentDir).root) {
		if (fs.existsSync(path.join(currentDir, "pnpm-workspace.yaml"))) {
			return currentDir
		}
		currentDir = path.dirname(currentDir)
	}
	return startDir // Fallback to cwd if root not found
}

program.name("pi-cli").description("PI Engine CLI for module scaffolding and workflow orchestration").version("1.0.0")

program
	.command("plan")
	.description("Plan a new feature intent")
	.argument("[intent]", "The feature intent to plan", "Set up core typescript application with default configurations")
	.action(async (intent) => {
		console.log(`Executing Agent Plan Routine for: "${intent}"`)
		const workingDir = findMonorepoRoot(process.cwd())
		const finalOutcomeState = await featurePlanningWorkflow(intent, workingDir)
		console.log("\n--- Execution State Log Output ---")
		console.log(`Final Engine Status: ${finalOutcomeState.status}`)
		console.log("Logs:")
		finalOutcomeState.logs.forEach((logLine: string) => console.log(` > ${logLine}`))
	})

program
	.command("scaffold")
	.description("Scaffold a new module")
	.argument("<module_name>", "The name of the module to scaffold")
	.action(async (moduleName) => {
		console.log(`Scaffolding module: ${moduleName}`)
		const workingDir = findMonorepoRoot(process.cwd())
		await executeCreateModuleWorkflow({ moduleName, rootPath: workingDir })
		console.log("Module layout created successfully.")
	})

program
	.command("list-modules")
	.description("List all discoverable modules")
	.action(async () => {
		const workingDir = findMonorepoRoot(process.cwd())
		const modules = discoverModules(workingDir)

		console.log(`\nFound ${modules.length} module(s):\n`)
		if (modules.length === 0) {
			console.log("  (No modules found in /modules)")
		} else {
			modules.forEach((m) => console.log(`  - ${m.name.padEnd(20)} v${m.version}`))
		}
		console.log("") // Final empty space
	})

program.parse(process.argv)
