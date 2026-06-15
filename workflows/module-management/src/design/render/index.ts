// Barrel for the renderers. Re-exports from the three render modules so
// the public API stays a flat namespace.

export { renderPreferencesFile, renderReadmeSource } from "./docs"
export {
	renderActionStubSource,
	renderManifestSource,
	renderTemplateStubSource,
	renderValidatorStubSource,
} from "./stubs"
export type { WriteFilesResult } from "./write"
export { writeModuleFiles } from "./write"
