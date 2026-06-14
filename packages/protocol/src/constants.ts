export const ENGINE_STATUS = {
	IDLE: "IDLE",
	PLANNING: "PLANNING",
	EXECUTING: "EXECUTING",
	COMPENSATING: "COMPENSATING",
	SUCCESS: "SUCCESS",
	FAILED: "FAILED",
} as const

export type EngineStatus = (typeof ENGINE_STATUS)[keyof typeof ENGINE_STATUS]

export const WORKSPACE_MODULES = {
	NEXT_BASE: "next-base",
	AUTH: "auth",
	DATABASE: "database",
	CMS: "cms",
} as const

export type WorkspaceModule = (typeof WORKSPACE_MODULES)[keyof typeof WORKSPACE_MODULES]
