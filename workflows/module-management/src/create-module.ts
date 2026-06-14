"use workflow"

import * as fs from "node:fs"
import path from "node:path"

export interface CreateModuleConfig {
	moduleName: string
	rootPath: string
}

async function createModuleDirectoryDurable(targetPath: string) {
	"use step"
	fs.mkdirSync(targetPath, { recursive: true })
	fs.mkdirSync(path.join(targetPath, "scripts"), { recursive: true })
	fs.mkdirSync(path.join(targetPath, "templates"), { recursive: true })
	return true
}

async function writeModuleFilesDurable(targetPath: string, moduleName: string) {
	"use step"
	const manifestTemplate = `import { ModuleManifest } from '@repo/protocol';

export const Manifest: ModuleManifest = {
  name: '${moduleName}',
  version: '1.0.0',
  dependencies: [],
  actions: [
    {
      id: 'init',
      description: 'Default boilerplate initialization routine for ${moduleName}',
      params: []
    }
  ]
};
`

	const packageJsonTemplate = `{
  "name": "@repo/module-${moduleName}",
  "version": "1.0.0",
  "private": true,
  "main": "./manifest.ts",
  "dependencies": {
    "@repo/protocol": "workspace:*"
  }
}
`

	fs.writeFileSync(path.join(targetPath, "manifest.ts"), manifestTemplate)
	fs.writeFileSync(path.join(targetPath, "package.json"), packageJsonTemplate)
	return true
}

export async function executeCreateModuleWorkflow(config: CreateModuleConfig): Promise<boolean> {
	const targetPath = path.join(config.rootPath, "modules", config.moduleName)

	if (fs.existsSync(targetPath)) {
		throw new Error(`Execution halted: Module path already exists at reference layout: ${targetPath}`)
	}

	await createModuleDirectoryDurable(targetPath)
	await writeModuleFilesDurable(targetPath, config.moduleName)

	return true
}
