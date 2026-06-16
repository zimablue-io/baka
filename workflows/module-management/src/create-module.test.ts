import fs from "node:fs"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { executeCreateModuleWorkflow } from "./create-module"

vi.mock("node:fs")
vi.mock("node:path")

describe("executeCreateModuleWorkflow", () => {
	it("should create module directory structure", async () => {
		vi.spyOn(fs, "existsSync").mockReturnValue(false)
		vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined)
		vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined)
		vi.spyOn(path, "join").mockImplementation((...args) => args.join("/"))

		const result = await executeCreateModuleWorkflow({ moduleName: "test-mod", rootPath: "/tmp" })

		expect(result).toBe(true)
		expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining("test-mod"), expect.anything())
	})
})
