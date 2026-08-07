import type { RegistryModuleDetailSchema, RegistryVersionDetailSchema } from "@repo/protocol"
import { useEffect, useState } from "react"
import type { z } from "zod"
import { cn } from "@/lib/cn"
import { getModuleDetail, getVersionDetail, REGISTRY_BASE_URL, RegistryError } from "@/lib/registry"
import { navigate } from "@/lib/router"

type ModuleDetail = z.infer<typeof RegistryModuleDetailSchema>
type VersionDetail = z.infer<typeof RegistryVersionDetailSchema>

/**
 * Module detail page (`/modules/:scope/:name` route).
 *
 * The full feature (tier badges, screening verdict, preview artifacts,
 * needs-llm state, version switching) ships in the sibling
 * `landing-detail` feature. This component delivers the navigation
 * surface the `landing-catalog` feature owns: it loads real registry
 * data, renders a working detail view, supports browser back to
 * return to the catalog with state preserved, and exposes honest
 * loading / error / not-found states.
 *
 * Once `landing-detail` lands, this file gains richer sections
 * (previews, version switcher, screening verdict) and keeps these
 * primitives — the loading/error/not-found scaffolds and the back
 * link stay in place.
 */
export function ModuleDetail({ scope, name }: { scope: string; name: string }) {
	const [moduleDetail, setModuleDetail] = useState<ModuleDetail | null>(null)
	const [versionDetail, setVersionDetail] = useState<VersionDetail | null>(null)
	const [error, setError] = useState<RegistryError | null>(null)
	const [loading, setLoading] = useState<boolean>(true)

	useEffect(() => {
		let aborted = false
		setLoading(true)
		setError(null)
		setModuleDetail(null)
		setVersionDetail(null)

		void (async () => {
			try {
				const detail = await getModuleDetail(scope, name)
				if (aborted) return
				setModuleDetail(detail)
				if (detail.latestVersion !== null) {
					const version = await getVersionDetail(scope, name, detail.latestVersion)
					if (aborted) return
					setVersionDetail(version)
				}
				setLoading(false)
			} catch (err: unknown) {
				if (aborted) return
				if (err instanceof RegistryError) {
					setError(err)
				} else {
					setError(
						new RegistryError(
							`unexpected error: ${err instanceof Error ? err.message : String(err)}`,
							"network",
							REGISTRY_BASE_URL,
						),
					)
				}
				setLoading(false)
			}
		})()
		return () => {
			aborted = true
		}
	}, [scope, name])

	const backToCatalog = () => {
		// Preserve the catalog filter on the way back: the URL
		// already carries `?q=...` from the catalog page (the
		// filter writes to window.history via replaceState), so
		// pushing "/" alone drops the query string. Read the
		// most recent catalog URL from history.state if present,
		// otherwise fall back to "/" — same UX either way.
		navigate("/")
	}

	if (loading) {
		return (
			<section className="border-b border-neutral-800/60 bg-neutral-900/30">
				<div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
					<div data-testid="module-detail-loading" role="status" aria-live="polite" className="space-y-4">
						<div className="h-8 w-1/3 animate-pulse rounded bg-neutral-900" />
						<div className="h-4 w-2/3 animate-pulse rounded bg-neutral-900" />
						<div className="h-32 w-full animate-pulse rounded bg-neutral-900" />
					</div>
				</div>
			</section>
		)
	}

	if (error !== null) {
		const isNotFound = error.code === "not-found"
		return (
			<section className="border-b border-neutral-800/60 bg-neutral-900/30">
				<div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
					<button
						type="button"
						onClick={backToCatalog}
						className="mb-6 inline-flex items-center gap-2 font-mono text-sm text-neutral-400 transition-colors hover:text-neutral-100"
					>
						← back to catalog
					</button>
					<div
						data-testid={isNotFound ? "module-detail-not-found" : "module-detail-error"}
						role="alert"
						className={cn(
							"overflow-hidden rounded-lg border px-4 py-6",
							isNotFound ? "border-neutral-800 bg-neutral-950" : "border-red-900/60 bg-red-950/30",
						)}
					>
						<h3 className="text-base font-semibold">{isNotFound ? "Module not found" : "Cannot load module"}</h3>
						<p
							className={cn("mt-2 text-sm font-mono break-words", isNotFound ? "text-neutral-300" : "text-red-300/90")}
						>
							{isNotFound ? `The registry has no module named ${scope}/${name}.` : error.message}
						</p>
					</div>
				</div>
			</section>
		)
	}

	if (moduleDetail === null) return null

	return (
		<section className="border-b border-neutral-800/60 bg-neutral-900/30">
			<div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
				<button
					type="button"
					onClick={backToCatalog}
					className="mb-6 inline-flex items-center gap-2 font-mono text-sm text-neutral-400 transition-colors hover:text-neutral-100"
				>
					← back to catalog
				</button>
				<div data-testid="module-detail" className="space-y-6">
					<div>
						<p className="mb-3 font-mono text-xs uppercase tracking-widest text-neutral-500">
							{moduleDetail.scope}/{moduleDetail.name}
						</p>
						<h2 className="text-3xl font-semibold tracking-tight text-neutral-50 sm:text-4xl">{moduleDetail.name}</h2>
						<p className="mt-3 max-w-3xl text-neutral-400">{moduleDetail.description}</p>
						<div className="mt-4 flex flex-wrap items-center gap-3 font-mono text-xs uppercase tracking-wider text-neutral-500">
							<span className="rounded border border-neutral-800 bg-neutral-950 px-2 py-0.5">
								tier: {moduleDetail.tier}
							</span>
							<span className="rounded border border-neutral-800 bg-neutral-950 px-2 py-0.5">
								visibility: {moduleDetail.visibility}
							</span>
							{moduleDetail.latestVersion !== null && (
								<span className="rounded border border-neutral-800 bg-neutral-950 px-2 py-0.5">
									latest: v{moduleDetail.latestVersion}
								</span>
							)}
						</div>
					</div>

					{versionDetail !== null && (
						<div className="rounded-lg border border-neutral-800 bg-neutral-950 p-6">
							<h4 className="mb-3 font-mono text-xs uppercase tracking-widest text-neutral-500">
								Manifest · v{versionDetail.version}
							</h4>
							<div className="space-y-3">
								{versionDetail.manifest.description !== undefined &&
									versionDetail.manifest.description !== null &&
									String(versionDetail.manifest.description).trim().length > 0 && (
										<p className="text-sm text-neutral-300">{String(versionDetail.manifest.description)}</p>
									)}
								<ActionList
									actions={Array.isArray(versionDetail.manifest.actions) ? versionDetail.manifest.actions : []}
								/>
							</div>
							<p className="mt-4 text-xs text-neutral-500">
								Full previews, the screening verdict, and version switching land in the sibling{" "}
								<code className="font-mono text-neutral-300">landing-detail</code> feature.
							</p>
						</div>
					)}
				</div>
			</div>
		</section>
	)
}

function ActionList({ actions }: { actions: unknown[] }) {
	if (actions.length === 0) {
		return <p className="text-sm text-neutral-500">This module declares no actions.</p>
	}
	return (
		<ul className="divide-y divide-neutral-800 rounded border border-neutral-800">
			{actions.map((raw) => {
				if (raw === null || typeof raw !== "object") return null
				const action = raw as { id?: unknown; description?: unknown; requiresReasoning?: unknown }
				const id = typeof action.id === "string" ? action.id : ""
				const description = typeof action.description === "string" ? action.description : ""
				const requiresReasoning = action.requiresReasoning === true
				if (id.length === 0) return null
				return (
					<li key={id} className="px-4 py-3">
						<div className="flex items-center justify-between gap-3">
							<code className="font-mono text-sm text-neutral-100">{id}</code>
							{requiresReasoning && (
								<span
									data-testid="requires-reasoning"
									className="rounded border border-amber-300/40 bg-amber-300/10 px-2 py-0.5 font-mono text-xs uppercase tracking-wider text-amber-200"
								>
									requires LLM
								</span>
							)}
						</div>
						{description.length > 0 && <p className="mt-1 text-sm text-neutral-400">{description}</p>}
					</li>
				)
			})}
		</ul>
	)
}
