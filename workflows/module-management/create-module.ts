import * as fs from "fs"
import * as path from "path"

export interface CreateModuleConfig {
	moduleName: string
	rootPath: string
}

export async function executeCreateModuleWorkflow(config: CreateModuleConfig): Promise<boolean> {
	const targetPath = path.join(config.rootPath, "modules", config.moduleName)

	if (fs.existsSync(targetPath)) {
		throw new Error(`Execution halted: Module path already exists at reference layout: ${targetPath}`)
	}

	// Create structure safely
	fs.mkdirSync(targetPath, { recursive: true })
	fs.mkdirSync(path.join(targetPath, "scripts"), { recursive: true })
	fs.mkdirSync(path.join(targetPath, "templates"), { recursive: true })

	const manifestTemplate = `import { ModuleManifest } from '@repo/protocol';

export const Manifest: ModuleManifest = {
  name: '${config.moduleName}',
  version: '1.0.0',
  dependencies: [],
  actions: [
    {
      id: 'init',
      description: 'Default boilerplate initialization routine for ${config.moduleName}',
      params: []
    }
  ]
};
`

	const packageJsonTemplate = `{
  "name": "@repo/module-${config.moduleName}",
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
