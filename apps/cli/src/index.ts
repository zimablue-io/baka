import { executeUserIntentWorkflow } from "../../../workflows/feature-planning/plan-intent.js"
import { executeCreateModuleWorkflow } from "../../../workflows/module-management/create-module.js"

async function runCliConsole() {
	const args = process.argv.slice(2)
	const coreCommand = args[0]

	if (!coreCommand) {
		console.log('Usage guidelines:\n  pnpm cli plan "<intent>"\n  pnpm cli scaffold "<module_name>"')
		process.exit(1)
	}

	const workingDir = process.cwd()

	try {
		if (coreCommand === "plan") {
			const intentValue = args[1] || "Set up core typescript application with default configurations"
			console.log(`Executing Agent Plan Routine for: "${intentValue}"`)

			const finalOutcomeState = await executeUserIntentWorkflow(intentValue, workingDir)

			console.log("\n--- Execution State Log Output ---")
			console.log(`Final Engine Status: ${finalOutcomeState.status}`)
			console.log("Logs:")
			finalOutcomeState.logs.forEach((logLine) => console.log(` > ${logLine}`))
		} else if (coreCommand === "scaffold") {
			const moduleNameValue = args[1]
			if (!moduleNameValue) {
				console.error("Error: Please supply a concrete configuration module name targeting /modules.")
				process.exit(1)
			}

			console.log(`Scaffolding module framework slice inside workspace directories: ${moduleNameValue}`)
			await executeCreateModuleWorkflow({ moduleName: moduleNameValue, rootPath: workingDir })
			console.log("Module layout created successfully.")
		} else {
			console.error(`Unknown parameter routing call argument: ${coreCommand}`)
			process.exit(1)
		}
	} catch (globalFaultError: any) {
		console.error("Fatal execution trap error inside engine run block:", globalFaultError.message)
		process.exit(1)
	}
}

runCliConsole()
