import { Input } from "@base-ui-components/react/input"
import type { RegistryCatalogEntry } from "@repo/protocol"
import { useEffect, useMemo, useState } from "react"
import { setCachedCatalog, useCachedCatalog } from "@/lib/catalog-cache"
import { cn } from "@/lib/cn"
import { getCatalog, REGISTRY_BASE_URL, RegistryError } from "@/lib/registry"
import { TierBadge } from "./TierBadge"

/**
 * Module catalog section — renders the live registry catalog.
 *
 * Data flow:
 *   1. Read the cached catalog (singleton across the app — survives
 *      navigation between `/` and `/modules/:scope/:name`).
 *   2. If the cache is empty, fire `GET /v1/modules` against the
 *      configured registry base URL. The first mount of the page
 *      does the fetch; every subsequent mount reuses the cache so
 *      a back-navigation does not flash a loading state.
 *   3. The filter input writes `?q=<value>` to the URL so the
 *      browser back button preserves it (VAL-WEB-009).
 *   4. Clicking a row pushes `/modules/<scope>/<name>` and the
 *      router transitions to the detail page (implemented in the
 *      sibling `landing-detail` feature).
 *
 * Three explicit UI states are rendered above the data path so the
 * assertion suite can find them deterministically:
 *
 *   - `data-testid="catalog-loading"` — the loading skeleton shown
 *     while the first fetch is in flight.
 *   - `data-testid="catalog-error"`   — the honest error UI when the
 *     registry is unreachable (names the URL it tried; never a
 *     blank page or a stack trace).
 *   - `data-testid="catalog-empty"`   — the explicit empty state
 *     shown when the registry has zero modules.
 *   - `data-testid="catalog-list"`    — the loaded catalog table.
 *
 * The catalog is fetched once per page load (not per mount) via the
 * singleton cache — see `src/lib/catalog-cache.ts`.
 */
export function ModuleCatalog() {
	const cached = useCachedCatalog()
	const [modules, setModules] = useState<RegistryCatalogEntry[] | null>(cached)
	const [loading, setLoading] = useState<boolean>(cached === null)
	const [error, setError] = useState<RegistryError | null>(null)
	const [query, setQuery] = useState<string>(() => readFilterFromLocation())

	// Persist the filter to the URL so browser back/forward + a deep
	// link with `?q=foo` restore the user's view (VAL-WEB-009,
	// architecture §8 decision 27).
	useEffect(() => {
		const url = new URL(window.location.href)
		if (query.trim().length === 0) {
			url.searchParams.delete("q")
		} else {
			url.searchParams.set("q", query.trim())
		}
		const nextSearch = url.searchParams.toString()
		const nextUrl = `${url.pathname}${nextSearch.length > 0 ? `?${nextSearch}` : ""}${url.hash}`
		// replaceState avoids polluting the history with every
		// keystroke — the user can still copy the filtered URL
		// (the search string is reflected in window.location).
		window.history.replaceState(window.history.state, "", nextUrl)
	}, [query])

	// React to history-driven location changes (back/forward
	// navigation that lands on the catalog): pull the latest filter
	// out of the URL and re-sync the input.
	useEffect(() => {
		const onPopState = () => {
			const next = readFilterFromLocation()
			setQuery((prev) => (prev === next ? prev : next))
		}
		window.addEventListener("popstate", onPopState)
		return () => {
			window.removeEventListener("popstate", onPopState)
		}
	}, [])

	// Fetch the catalog from the registry. The cache is the source
	// of truth — on subsequent mounts of this component (back
	// navigation from a detail page) we skip the fetch and render
	// from cache, which is what makes the back button feel
	// instant.
	useEffect(() => {
		if (cached !== null) return
		let aborted = false
		setLoading(true)
		setError(null)
		void getCatalog()
			.then((data) => {
				if (aborted) return
				setCachedCatalog(data)
				setModules(data)
				setLoading(false)
			})
			.catch((err: unknown) => {
				if (aborted) return
				const registryError =
					err instanceof RegistryError
						? err
						: new RegistryError(
								`unexpected error: ${err instanceof Error ? err.message : String(err)}`,
								"network",
								REGISTRY_BASE_URL,
							)
				setError(registryError)
				setLoading(false)
			})
		return () => {
			aborted = true
		}
	}, [cached])

	const retry = () => {
		setCachedCatalog(null)
		setModules(null)
		setLoading(true)
		setError(null)
		void getCatalog()
			.then((data) => {
				setCachedCatalog(data)
				setModules(data)
				setLoading(false)
			})
			.catch((err: unknown) => {
				const registryError =
					err instanceof RegistryError
						? err
						: new RegistryError(
								`unexpected error: ${err instanceof Error ? err.message : String(err)}`,
								"network",
								REGISTRY_BASE_URL,
							)
				setError(registryError)
				setLoading(false)
			})
	}

	const orgs = useMemo(() => {
		const list = modules ?? []
		return [...new Set(list.map((m) => m.scope))].sort()
	}, [modules])

	const filtered = useMemo(() => {
		const list = modules ?? []
		const q = query.trim().toLowerCase()
		if (q.length === 0) return list
		return list.filter((m) => {
			return (
				m.name.toLowerCase().includes(q) || m.scope.toLowerCase().includes(q) || m.description.toLowerCase().includes(q)
			)
		})
	}, [modules, query])

	return (
		<section id="modules" className="border-b border-neutral-800/60 bg-neutral-900/30">
			<div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
				<div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
					<div className="max-w-2xl">
						<p className="mb-3 font-mono text-xs uppercase tracking-widest text-neutral-500">Module catalog</p>
						<h2 className="text-3xl font-semibold tracking-tight text-neutral-50 sm:text-4xl">
							Modules from the registry.
						</h2>
						<p className="mt-3 text-neutral-400">
							Public catalog grouped by org. Publish with{" "}
							<code className="font-mono text-neutral-300">baka publish</code>. Each module is a versioned catalog of
							declared actions.
						</p>
					</div>
					<div className="w-full sm:w-72">
						<label htmlFor="module-search" className="sr-only">
							Search modules
						</label>
						<Input
							id="module-search"
							placeholder="Search modules…"
							value={query}
							onValueChange={setQuery}
							className={cn(
								"h-10 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm",
								"text-neutral-100 placeholder:text-neutral-500",
								"focus:border-neutral-600 focus:outline-none focus:ring-2 focus:ring-neutral-700",
							)}
						/>
					</div>
				</div>

				{orgs.length > 0 ? (
					<div data-testid="catalog-orgs" className="mb-6 flex flex-wrap gap-2">
						<button
							type="button"
							onClick={() => setQuery("")}
							className="rounded-full border border-neutral-800 px-3 py-1 text-xs text-neutral-300 hover:border-neutral-600"
						>
							All orgs
						</button>
						{orgs.map((org) => (
							<button
								key={org}
								type="button"
								onClick={() => setQuery(org)}
								className="rounded-full border border-neutral-800 px-3 py-1 font-mono text-xs text-neutral-300 hover:border-neutral-600"
							>
								@{org}
							</button>
						))}
					</div>
				) : null}

				{loading ? (
					<div
						data-testid="catalog-loading"
						role="status"
						aria-live="polite"
						className="overflow-hidden rounded-lg border border-neutral-800"
					>
						<div className="space-y-2 p-4">
							<div className="h-6 w-1/3 animate-pulse rounded bg-neutral-900" />
							<div className="h-6 w-1/2 animate-pulse rounded bg-neutral-900" />
							<div className="h-6 w-2/5 animate-pulse rounded bg-neutral-900" />
						</div>
					</div>
				) : error !== null ? (
					<div
						data-testid="catalog-error"
						role="alert"
						className="overflow-hidden rounded-lg border border-red-900/60 bg-red-950/30"
					>
						<div className="px-4 py-6">
							<h3 className="text-base font-semibold text-red-200">Cannot reach the registry</h3>
							<p className="mt-2 text-sm text-red-300/90 font-mono break-words">{error.message}</p>
							<p className="mt-3 text-sm text-neutral-400">
								The catalog could not be loaded from the configured registry. Start the registry on{" "}
								<code className="font-mono text-neutral-300">{REGISTRY_BASE_URL}</code> or set{" "}
								<code className="font-mono text-neutral-300">VITE_REGISTRY_URL</code> to a reachable registry before
								rebuilding the landing app.
							</p>
							<button
								type="button"
								onClick={retry}
								className={cn(
									"mt-4 inline-flex h-9 items-center justify-center rounded-md border border-red-900/60 bg-red-950/30 px-4 text-sm font-medium text-red-100 transition-colors hover:bg-red-900/40",
								)}
							>
								Retry
							</button>
						</div>
					</div>
				) : modules === null || modules.length === 0 ? (
					<div
						data-testid="catalog-empty"
						className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-12 text-center"
					>
						<h3 className="text-base font-semibold text-neutral-200">No modules published yet</h3>
						<p className="mt-2 text-sm text-neutral-500">
							The registry at <code className="font-mono text-neutral-300">{REGISTRY_BASE_URL}</code> has no published
							modules. Publish one with the baka CLI, or check back once modules are published.
						</p>
					</div>
				) : (
					<div data-testid="catalog-list" className="overflow-hidden rounded-lg border border-neutral-800">
						<table className="w-full text-left text-sm">
							<thead className="bg-neutral-900 text-xs uppercase tracking-wider text-neutral-400">
								<tr>
									<th className="px-4 py-3 font-medium">Module</th>
									<th className="px-4 py-3 font-medium">Version</th>
									<th className="px-4 py-3 font-medium">Tier</th>
									<th className="px-4 py-3 font-medium">Description</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-neutral-800">
								{filtered.length === 0 ? (
									<tr>
										<td colSpan={4} className="px-4 py-10 text-center text-neutral-500">
											No modules match <span className="font-mono text-neutral-300">"{query.trim()}"</span>.
										</td>
									</tr>
								) : (
									filtered.map((m) => <CatalogRow key={`${m.scope}/${m.name}`} module={m} query={query.trim()} />)
								)}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</section>
	)
}

function CatalogRow({ module, query }: { module: RegistryCatalogEntry; query: string }) {
	const href = `/modules/${encodeURIComponent(module.scope)}/${encodeURIComponent(module.name)}`
	return (
		<tr
			data-testid="catalog-row"
			data-scope={module.scope}
			data-name={module.name}
			data-tier={module.tier}
			className="bg-neutral-950 transition-colors hover:bg-neutral-900"
		>
			<td className="px-4 py-3 font-mono text-neutral-100">
				<a
					href={href}
					className="block text-neutral-100 hover:text-white focus:outline-none focus-visible:text-white"
					data-testid="catalog-row-link"
				>
					<span>{highlight(module.scope, query)}</span>
					<span aria-hidden="true"> / </span>
					<span>{highlight(module.name, query)}</span>
				</a>
			</td>
			<td className="px-4 py-3 font-mono text-neutral-500">
				{module.latestVersion === null ? "—" : `v${module.latestVersion}`}
			</td>
			<td className="px-4 py-3">
				<TierBadge tier={module.tier} />
			</td>
			<td className="px-4 py-3 text-neutral-400">
				<a
					href={href}
					className="block text-neutral-400 hover:text-neutral-100 focus:outline-none focus-visible:text-neutral-100"
					aria-label={`View ${module.scope}/${module.name}`}
				>
					{module.description}
				</a>
			</td>
		</tr>
	)
}

function highlight(text: string, query: string): React.ReactNode {
	const q = query.trim().toLowerCase()
	if (q.length === 0) return text
	const lower = text.toLowerCase()
	const index = lower.indexOf(q)
	if (index === -1) return text
	return (
		<>
			{text.slice(0, index)}
			<span className="bg-neutral-700/60 text-neutral-50">{text.slice(index, index + q.length)}</span>
			{text.slice(index + q.length)}
		</>
	)
}

function readFilterFromLocation(): string {
	if (typeof window === "undefined") return ""
	const params = new URLSearchParams(window.location.search)
	return params.get("q") ?? ""
}
