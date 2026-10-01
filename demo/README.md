# Demo project

A real consumer project. The modules in `modules/` write a Vite + TypeScript app into this folder. Open this folder in the dashboard to experiment.

**This build (salt-dock):** dark navy `#102a43`, mint links `#38d9a9`, copy filled by local `gemma4:e4b`. Home should say “versatile application”; About should say “community-driven project”. Cream/serif `north-room` is the previous run — if you still see that, hard-refresh.

| Module | Action | Writes |
|---|---|---|
| `vite-app` | `write` | `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.ts` |
| `vite-theme` | `write` | `src/styles.css` (params only — change colors in the dashboard) |
| `vite-page` | `write` | `{{slug}}.html` + `src/{{slug}}.ts` |

The engine skips a file if it already exists. Delete the generated file to write it again.

```bash
# terminal 1 — engine bound to this folder
pnpm --filter baka exec node dist/index.js serve --cwd demo --port 4311

# terminal 2 — dashboard
pnpm --filter @baka/dashboard dev
```

Set **Project folder** to the absolute path of this `demo/` directory, then **Load modules**.

After the modules have written the app (this folder is not in the pnpm workspace):

```bash
cd demo && npm install && npm run dev
```
