import type { RegistryCatalogEntry, RegistryPreviewEntry } from "@repo/protocol"
import { useEffect, useState } from "react"
import { getCatalog, getPreviewList, REGISTRY_BASE_URL, RegistryError } from "@/lib/registry"

interface ResultRow {
	scope: string
	name: string
	version: string
	previews: RegistryPreviewEntry[]
}

/**
 * Results gallery: screening preview artifacts from the registry.
 * LLM slots render as labeled holes (`needs-llm`) unless a pinned fill
 * was published (`rendered`). Hosting the registry is Needs Human (DEV-219).
 */
export function ResultsGallery() {
	const [rows, setRows] = useState<ResultRow[] | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		let cancelled = false
		;(async () => {
			try {
				const catalog: RegistryCatalogEntry[] = await getCatalog()
				const loaded: ResultRow[] = []
				for (const mod of catalog) {
					if (!mod.latestVersion) continue
					try {
						const list = await getPreviewList(mod.scope, mod.name, mod.latestVersion)
						loaded.push({
							scope: mod.scope,
							name: mod.name,
							version: mod.latestVersion,
							previews: list.previews,
						})
					} catch {
						loaded.push({
							scope: mod.scope,
							name: mod.name,
							version: mod.latestVersion,
							previews: [],
						})
					}
				}
				if (!cancelled) setRows(loaded)
			} catch (err) {
				const message = err instanceof RegistryError ? err.message : String(err)
				if (!cancelled) setError(message)
			}
		})()
		return () => {
			cancelled = true
		}
	}, [])

	if (error) {
		return (
			<section className="mx-auto max-w-6xl px-6 py-16" data-testid="results-error">
				<p className="text-neutral-400">
					Could not load results from {REGISTRY_BASE_URL}: {error}
				</p>
			</section>
		)
	}
	if (rows === null) {
		return (
			<section className="mx-auto max-w-6xl px-6 py-16" data-testid="results-loading">
				<p className="text-neutral-500">Loading screening previews…</p>
			</section>
		)
	}
	if (rows.length === 0) {
		return (
			<section className="mx-auto max-w-6xl px-6 py-16" data-testid="results-empty">
				<p className="text-neutral-400">No published modules yet. Publish with `baka publish`.</p>
			</section>
		)
	}

	return (
		<section className="mx-auto max-w-6xl px-6 py-16" data-testid="results-list">
			<h1 className="text-2xl font-semibold text-neutral-100">Results</h1>
			<p className="mt-2 max-w-2xl text-sm text-neutral-400">
				Screening previews from the registry. Named LLM slots show as labeled holes unless a pinned fill was published.
				Reproducible on gemma4:e4b, not a hidden frontier model.
			</p>
			<ul className="mt-8 space-y-6">
				{rows.map((row) => (
					<li key={`${row.scope}/${row.name}`} className="rounded-lg border border-neutral-800 p-4">
						<a className="font-mono text-neutral-100" href={`/modules/${row.scope}/${row.name}`}>
							@{row.scope}/{row.name}@{row.version}
						</a>
						<ul className="mt-3 space-y-1 text-sm text-neutral-400">
							{row.previews.length === 0 ? (
								<li>no preview available</li>
							) : (
								row.previews.map((p) => (
									<li key={p.actionId}>
										<span className="font-mono text-neutral-300">{p.actionId}</span>
										{p.state === "needs-llm" ? (
											<span> — LLM slots are labeled holes (fill on gemma4:e4b)</span>
										) : (
											<span> — rendered tree</span>
										)}
									</li>
								))
							)}
						</ul>
					</li>
				))}
			</ul>
		</section>
	)
}
