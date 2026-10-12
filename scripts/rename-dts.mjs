#!/usr/bin/env node
// tsup names the type bundle of a package without "type": "module" index.d.mts. The published manifest is a
// module (publishConfig), so its types must be index.d.ts: rename them after the build.
import { existsSync, renameSync } from "node:fs"
import { join } from "node:path"

const dir = process.argv[2] ?? "dist"
const from = join(dir, "index.d.mts")
if (existsSync(from)) renameSync(from, join(dir, "index.d.ts"))
