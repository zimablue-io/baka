import type {
	RegistryPreviewEntry,
	RegistryPreviewListResponseSchema,
	RegistryRecipePreviewSchema,
	RegistryTier,
	RegistryVersionDetailSchema,
	RegistryVersionSummary,
} from "@repo/protocol"
import { useEffect, useState } from "react"
import type { z } from "zod"
import { cn } from "@/lib/cn"
import {
	getPackDetail,
	getPreviewList,
	getRecipePreview,
	getVersionDetail,
	REGISTRY_BASE_URL,
	RegistryError,
} from "@/lib/registry"
import { navigate } from "@/lib/router"
import { TierBadge } from "./TierBadge"

type PackDetail = z.infer<typeof RegistryVersionDetailSchema>
type PreviewList = z.infer<typeof RegistryPreviewListResponseSchema>
type RecipePreview = z.infer<typeof RegistryRecipePreviewSchema>

interface PackSummary {
	scope: string
	name: string
	tier: RegistryTier
	visibility: "public" | "org" | string
	description: string
	latestVersion: string | null
	versions: RegistryVersionSummary[]
}

/**
 * Pack detail page (`/packs/:scope/:name` route).
 *
 * Fulfils the `landing-detail` feature: real manifest display, recipe
 * list with params, tier badge per verdict, generated-code preview per
 * recipe from preview artifacts, honest needs-llm state, 404 page for
 * unknown packs, explicit empty state for missing previews, large
 * previews fully rendered, and version switching that re-fetches the
 * selected version. The verdict surfaces consistently with the API
 * (VAL-WEB-004 / VAL-CROSS-005).
 *
 * Data flow:
 *   1. On mount and whenever the (scope, name, version) triple changes,
 *      fetch the pack summary (for the version list to drive the
 *      switcher) and the version detail (manifest + screening).
 *   2. With the version detail loaded, fetch the preview list to know
 *      which recipes have a preview record vs. need a per-recipe fetch
 *      vs. have no preview at all (VAL-WEB-013: explicit empty state).
 *   3. Each recipe tile renders one of three documented states:
 *        - "rendered"    — fetched file contents for this recipe, code
 *                          block per file, all bytes faithfully shown
 *                          (VAL-WEB-014: large previews fully rendered).
 *        - "needs-llm"   — explicit "requires an LLM at apply time" UI,
 *                          plus the sentinel-rendered template with
 *                          fixture params when the recipe ships one
 *                          (VAL-WEB-006 + VAL-SCAN-005 conditional).
 *        - no record     — explicit "no preview available" empty state
 *                          (VAL-WEB-013).
 *
 * Version switching writes the selected version to the URL via
 * `?version=<tag>` so the user can share a link to a specific version
 * (VAL-WEB-015). The default view (no `?version=`) shows the latest
 * version per the pack summary's `latestVersion` pointer.
 *
 * Back navigation: a dedicated back button returns to the catalog.
 * The catalog filter (`?q=...`) was already preserved through the
 * singular `navigate("/")` call by leaving the catalog's URL alone
 * (the catalog re-reads the filter on mount).
 */
export function PackDetail({ scope, name }: { scope: string; name: string }) {
	const [packSummary, setPackSummary] = useState<PackSummary | null>(null)
	const [versionDetail, setVersionDetail] = useState<PackDetail | null>(null)
	const [previewList, setPreviewList] = useState<PreviewList | null>(null)
	const [requestedVersion, setRequestedVersion] = useState<string | null>(() => readVersionFromLocation())
	const [error, setError] = useState<RegistryError | null>(null)
	const [loading, setLoading] = useState<boolean>(true)

	// Resolve the version to fetch. If the URL has `?version=<tag>` we
	// fetch that tag; otherwise we wait for the pack summary
	// (`latestVersion`) and use that. The effect below re-runs when
	// either the URL or the latest pointer changes.
	const effectiveVersion: string | null = requestedVersion ?? packSummary?.latestVersion ?? null

	useEffect(() => {
		let aborted = false
		setLoading(true)
		setError(null)
		setPackSummary(null)
		setVersionDetail(null)
		setPreviewList(null)

		void (async () => {
			try {
				// The pack summary is the single source of truth for
				// the version list (the version-detail endpoint does
				// not return a list of other versions). The summary
				// also drives `latestVersion` when the URL has no
				// `?version=`.
				const summary = await getPackDetail(scope, name)
				if (aborted) return
				const summaryShape: PackSummary = {
					scope: summary.scope,
					name: summary.name,
					tier: summary.tier,
					visibility: summary.visibility,
					description: summary.description,
					latestVersion: summary.latestVersion,
					versions: summary.versions,
				}
				setPackSummary(summaryShape)
				// After the summary lands, the effective version may
				// shift to `latestVersion`. The effect below picks up
				// the change and fetches the version detail.
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

	// Fetch the version detail AND the preview list in parallel once
	// the effective version is known. The preview list is short
	// (~one entry per recipe) and bounded by the manifest's recipe
	// count, so a single fetch is sufficient — per-recipe file
	// contents are fetched lazily by each PreviewTile component.
	useEffect(() => {
		if (effectiveVersion === null) return
		const targetVersion = effectiveVersion
		let aborted = false
		setLoading(true)
		setError(null)
		setVersionDetail(null)
		setPreviewList(null)
		void (async () => {
			try {
				const [version, previews] = await Promise.all([
					getVersionDetail(scope, name, targetVersion),
					getPreviewList(scope, name, targetVersion),
				])
				if (aborted) return
				setVersionDetail(version)
				setPreviewList(previews)
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
	}, [scope, name, effectiveVersion])

	const backToCatalog = () => {
		navigate("/")
	}

	const changeVersion = (nextVersion: string) => {
		const url = new URL(window.location.href)
		if (nextVersion === packSummary?.latestVersion) {
			// Selecting the latest version is the default; drop the
			// query string so the URL matches the no-`?version` form.
			url.searchParams.delete("version")
		} else {
			url.searchParams.set("version", nextVersion)
		}
		const nextSearch = url.searchParams.toString()
		const nextPath = `${url.pathname}${nextSearch.length > 0 ? `?${nextSearch}` : ""}`
		// `replaceState` so a version switch doesn't pollute the
		// history with every click — the user can still use the
		// browser back button to leave the detail page.
		window.history.replaceState(window.history.state, "", nextPath)
		setRequestedVersion(nextVersion === packSummary?.latestVersion ? null : nextVersion)
	}

	if (loading && packSummary === null) {
		return (
			<section className="border-b border-neutral-800/60 bg-neutral-900/30">
				<div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
					<div data-testid="pack-detail-loading" role="status" aria-live="polite" className="space-y-4">
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
						data-testid={isNotFound ? "pack-detail-not-found" : "pack-detail-error"}
						role="alert"
						className={cn(
							"overflow-hidden rounded-lg border px-4 py-6",
							isNotFound ? "border-neutral-800 bg-neutral-950" : "border-red-900/60 bg-red-950/30",
						)}
					>
						<h3 className="text-base font-semibold">{isNotFound ? "Pack not found" : "Cannot load pack"}</h3>
						<p
							className={cn("mt-2 text-sm font-mono break-words", isNotFound ? "text-neutral-300" : "text-red-300/90")}
						>
							{isNotFound ? `The registry has no pack named ${scope}/${name}.` : error.message}
						</p>
					</div>
				</div>
			</section>
		)
	}

	if (packSummary === null) return null

	// The version-detail fetch is still in flight (the summary has
	// landed but the per-version data has not). Render a smaller
	// skeleton that does not duplicate the "pack not found" state.
	if (versionDetail === null) {
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
					<div role="status" aria-live="polite" className="space-y-4">
						<div className="h-8 w-1/3 animate-pulse rounded bg-neutral-900" />
						<div className="h-64 w-full animate-pulse rounded bg-neutral-900" />
					</div>
				</div>
			</section>
		)
	}

	// The manifest's "recipes" array is the canonical source of
	// recipe ids (the preview list is a strict subset when all
	// recipes have records). We index preview records by recipeId
	// for O(1) tile lookup. The preview list being empty is
	// honest data — the registry returns `[]` for org-private
	// packs (VAL-SCAN-001) and for packs that have not been
	// screened.
	const recipes = Array.isArray(versionDetail.manifest.recipes)
		? (versionDetail.manifest.recipes as Array<Record<string, unknown>>)
		: []
	const previewsByRecipe = new Map<string, RegistryPreviewEntry>()
	for (const preview of previewList?.previews ?? []) {
		previewsByRecipe.set(preview.recipeId, preview)
	}

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
				<div data-testid="pack-detail" className="space-y-8">
					<header className="space-y-4">
						<p className="font-mono text-xs uppercase tracking-widest text-neutral-500">
							{packSummary.scope}/{packSummary.name}
						</p>
						<h1 className="text-3xl font-semibold tracking-tight text-neutral-50 sm:text-4xl">{packSummary.name}</h1>
						<p className="max-w-3xl text-neutral-400">{packSummary.description}</p>
						<div className="flex flex-wrap items-center gap-3 font-mono text-xs uppercase tracking-wider text-neutral-500">
							<span data-testid="pack-detail-tier">
								<TierBadge tier={versionDetail.tier} />
							</span>
							<span className="rounded border border-neutral-800 bg-neutral-950 px-2 py-0.5">
								visibility: {packSummary.visibility}
							</span>
						</div>
					</header>

					<VersionSwitcher
						versions={packSummary.versions}
						latestVersion={packSummary.latestVersion}
						selectedVersion={effectiveVersion}
						onChange={changeVersion}
					/>

					{versionDetail.screening !== null && versionDetail.screening !== undefined && (
						<ScreeningVerdict screening={versionDetail.screening} />
					)}

					<section
						aria-labelledby="manifest-heading"
						className="rounded-lg border border-neutral-800 bg-neutral-950 p-6"
					>
						<header className="mb-4">
							<h2
								id="manifest-heading"
								data-testid="manifest-heading"
								className="font-mono text-xs uppercase tracking-widest text-neutral-500"
							>
								Manifest · v{versionDetail.version}
							</h2>
						</header>
						{manifestDescription(versionDetail).length > 0 && (
							<p className="mb-4 text-sm text-neutral-300">{manifestDescription(versionDetail)}</p>
						)}
						<ManifestMeta versionDetail={versionDetail} />
					</section>

					<section aria-labelledby="recipes-heading" className="space-y-4">
						<header className="flex items-end justify-between">
							<h2
								id="recipes-heading"
								data-testid="recipes-heading"
								className="font-mono text-xs uppercase tracking-widest text-neutral-500"
							>
								Recipes
							</h2>
							<span className="font-mono text-xs text-neutral-600">
								{recipes.length} {recipes.length === 1 ? "recipe" : "recipes"}
							</span>
						</header>
						{recipes.length === 0 ? (
							<p className="rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-6 text-sm text-neutral-500">
								This pack declares no recipes.
							</p>
						) : (
							<ul data-testid="recipe-list" className="space-y-4">
								{recipes.map((recipe) => {
									const recipeId = typeof recipe.id === "string" ? recipe.id : ""
									if (recipeId.length === 0) return null
									return (
										<RecipeTile
											key={recipeId}
											recipe={recipe}
											preview={previewsByRecipe.get(recipeId)}
											scope={packSummary.scope}
											name={packSummary.name}
											version={versionDetail.version}
										/>
									)
								})}
							</ul>
						)}
					</section>
				</div>
			</div>
		</section>
	)
}

function manifestDescription(versionDetail: PackDetail): string {
	const description = versionDetail.manifest.description
	if (typeof description !== "string") return ""
	return description.trim()
}

function ManifestMeta({ versionDetail }: { versionDetail: PackDetail }) {
	const manifest = versionDetail.manifest
	const dependencies = Array.isArray(manifest.dependencies) ? (manifest.dependencies as unknown[]) : []
	const conflicts = Array.isArray(manifest.conflictsWith) ? (manifest.conflictsWith as unknown[]) : []
	const packValidators = Array.isArray(manifest.packValidators) ? (manifest.packValidators as unknown[]) : []
	const hasMeta = dependencies.length > 0 || conflicts.length > 0 || packValidators.length > 0
	if (!hasMeta) return null
	return (
		<dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
			{dependencies.length > 0 && (
				<div>
					<dt className="font-mono text-xs uppercase tracking-widest text-neutral-500">Dependencies</dt>
					<dd className="mt-1 font-mono text-neutral-300">{dependencies.join(", ")}</dd>
				</div>
			)}
			{conflicts.length > 0 && (
				<div>
					<dt className="font-mono text-xs uppercase tracking-widest text-neutral-500">Conflicts with</dt>
					<dd className="mt-1 font-mono text-neutral-300">{conflicts.join(", ")}</dd>
				</div>
			)}
			{packValidators.length > 0 && (
				<div>
					<dt className="font-mono text-xs uppercase tracking-widest text-neutral-500">Pack validators</dt>
					<dd className="mt-1 font-mono text-neutral-300">{packValidators.join(", ")}</dd>
				</div>
			)}
		</dl>
	)
}

function VersionSwitcher({
	versions,
	latestVersion,
	selectedVersion,
	onChange,
}: {
	versions: RegistryVersionSummary[]
	latestVersion: string | null
	selectedVersion: string | null
	onChange: (version: string) => void
}) {
	if (versions.length === 0) return null
	// Sort the versions newest-first (the detail page can also be
	// reached with a `?version=<tag>` URL pointing at an older
	// version, so we keep the chronological list intact).
	const sorted = [...versions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
	return (
		<nav
			aria-label="Versions"
			data-testid="version-switcher"
			className="flex flex-wrap items-center gap-2 border-b border-neutral-800 pb-2 font-mono text-xs"
		>
			<span className="mr-2 uppercase tracking-widest text-neutral-500">Version:</span>
			{sorted.map((v) => {
				const isLatest = v.version === latestVersion
				const isSelected = v.version === selectedVersion
				return (
					<button
						key={v.version}
						type="button"
						onClick={() => onChange(v.version)}
						data-testid="version-switcher-option"
						data-version={v.version}
						data-selected={isSelected ? "true" : "false"}
						disabled={v.status !== "ready"}
						className={cn(
							"rounded border px-2 py-0.5 transition-colors",
							isSelected
								? "border-neutral-100 bg-neutral-100 text-neutral-950"
								: "border-neutral-800 bg-neutral-950 text-neutral-300 hover:border-neutral-600 hover:text-neutral-100",
							v.status !== "ready" && "cursor-not-allowed opacity-50 hover:border-neutral-800 hover:text-neutral-300",
						)}
					>
						v{v.version}
						{isLatest && <span className="ml-1 text-[10px] uppercase tracking-widest opacity-70">latest</span>}
						{v.status !== "ready" && (
							<span className="ml-1 text-[10px] uppercase tracking-widest opacity-70">{v.status}</span>
						)}
					</button>
				)
			})}
		</nav>
	)
}

function ScreeningVerdict({ screening }: { screening: NonNullable<PackDetail["screening"]> }) {
	return (
		<section
			aria-labelledby="screening-heading"
			data-testid="screening-verdict"
			className="rounded-lg border border-neutral-800 bg-neutral-950 p-6"
		>
			<header className="mb-3 flex items-center justify-between">
				<h2 id="screening-heading" className="font-mono text-xs uppercase tracking-widest text-neutral-500">
					Screening verdict
				</h2>
				<span
					data-testid="screening-verdict-verdict"
					className={cn(
						"rounded-md border px-2 py-0.5 font-mono text-xs uppercase tracking-wider",
						screening.verdict === "screened"
							? "border-emerald-300/40 bg-emerald-300/10 text-emerald-200"
							: screening.verdict === "failed"
								? "border-red-900/60 bg-red-950/30 text-red-200"
								: "border-neutral-700 bg-neutral-900 text-neutral-300",
					)}
				>
					{screening.verdict}
				</span>
			</header>
			{typeof screening.createdAt === "string" && screening.createdAt.length > 0 && (
				<p className="font-mono text-xs text-neutral-500">screened at {screening.createdAt}</p>
			)}
		</section>
	)
}

function RecipeTile({
	recipe,
	preview,
	scope,
	name,
	version,
}: {
	recipe: Record<string, unknown>
	preview: RegistryPreviewEntry | undefined
	scope: string
	name: string
	version: string
}) {
	const id = typeof recipe.id === "string" ? recipe.id : ""
	const description = typeof recipe.description === "string" ? recipe.description : ""
	const requiresReasoning = recipe.requiresReasoning === true
	const params = Array.isArray(recipe.params) ? (recipe.params as unknown[]) : []
	const filePatterns = Array.isArray(recipe.filePatterns) ? (recipe.filePatterns as unknown[]) : []
	const validators = Array.isArray(recipe.validators) ? (recipe.validators as unknown[]) : []
	if (id.length === 0) return null

	const previewState = preview?.state

	return (
		<li data-testid="recipe-tile" data-recipe-id={id} className="rounded-lg border border-neutral-800 bg-neutral-950">
			<header className="flex flex-wrap items-center gap-3 border-b border-neutral-800 px-4 py-3">
				<code className="font-mono text-sm text-neutral-100">{id}</code>
				{requiresReasoning && (
					<span
						data-testid="requires-reasoning"
						className="rounded border border-amber-300/40 bg-amber-300/10 px-2 py-0.5 font-mono text-xs uppercase tracking-wider text-amber-200"
					>
						requires LLM
					</span>
				)}
				{previewState === "rendered" && (
					<span
						data-testid="preview-state"
						data-state="rendered"
						className="rounded border border-emerald-300/40 bg-emerald-300/10 px-2 py-0.5 font-mono text-xs uppercase tracking-wider text-emerald-200"
					>
						preview rendered
					</span>
				)}
				{previewState === "needs-llm" && (
					<span
						data-testid="preview-state"
						data-state="needs-llm"
						className="rounded border border-amber-300/40 bg-amber-300/10 px-2 py-0.5 font-mono text-xs uppercase tracking-wider text-amber-200"
					>
						needs LLM
					</span>
				)}
			</header>
			<div className="space-y-4 px-4 py-4">
				{description.length > 0 && <p className="text-sm text-neutral-300">{description}</p>}

				{params.length > 0 && (
					<dl data-testid="recipe-params" className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
						{params.map((raw, index) => {
							if (raw === null || typeof raw !== "object") return null
							const param = raw as Record<string, unknown>
							const pName = typeof param.name === "string" ? param.name : `param-${index}`
							const pType = typeof param.type === "string" ? param.type : "string"
							const pRequired = param.required === true
							const pDescription = typeof param.description === "string" ? param.description : ""
							const enumValues = Array.isArray(param.enumValues) ? (param.enumValues as unknown[]) : []
							return (
								<div key={pName} data-testid="recipe-param" data-param-name={pName}>
									<dt className="font-mono text-xs">
										<span className="text-neutral-100">{pName}</span>
										<span className="ml-2 text-neutral-500">{pType}</span>
										{pRequired && (
											<span className="ml-2 text-amber-200" title="required">
												required
											</span>
										)}
									</dt>
									{pDescription.length > 0 && <dd className="text-xs text-neutral-400">{pDescription}</dd>}
									{enumValues.length > 0 && (
										<dd className="mt-1 font-mono text-xs text-neutral-500">
											values: {enumValues.map((v) => String(v)).join(" · ")}
										</dd>
									)}
								</div>
							)
						})}
					</dl>
				)}

				{(filePatterns.length > 0 || validators.length > 0) && (
					<div className="flex flex-wrap gap-3 font-mono text-xs text-neutral-500">
						{filePatterns.length > 0 && (
							<span>
								<span className="uppercase tracking-widest">files: </span>
								<span className="text-neutral-300">{filePatterns.map((p) => String(p)).join(", ")}</span>
							</span>
						)}
						{validators.length > 0 && (
							<span>
								<span className="uppercase tracking-widest">validators: </span>
								<span className="text-neutral-300">{validators.map((v) => String(v)).join(", ")}</span>
							</span>
						)}
					</div>
				)}

				<PreviewRegion recipeId={id} preview={preview} scope={scope} name={name} version={version} />
			</div>
		</li>
	)
}

function PreviewRegion({
	recipeId,
	preview,
	scope,
	name,
	version,
}: {
	recipeId: string
	preview: RegistryPreviewEntry | undefined
	scope: string
	name: string
	version: string
}) {
	// No preview record at all — explicit empty state per
	// VAL-WEB-013. The registry returns `[]` for org-visibility
	// packs (screening skipped) and the preview list per-recipe
	// can omit recipes that never produced a record.
	if (preview === undefined) {
		return (
			<div
				data-testid="preview-empty"
				role="status"
				aria-label={`No preview available for recipe ${recipeId}`}
				className="rounded border border-dashed border-neutral-800 bg-neutral-900/40 px-4 py-6 text-center"
			>
				<p className="text-sm text-neutral-300">No preview available</p>
				<p className="mt-1 text-xs text-neutral-500">
					This recipe has no preview record — it may be org-private, unscreened, or generated content that the registry
					cannot materialize.
				</p>
			</div>
		)
	}

	if (preview.state === "needs-llm") {
		// `needs-llm` is a first-class state, not an error. The
		// registry returns the reason verbatim; the landing surfaces
		// it directly so the user sees the same string the registry
		// generated (VAL-WEB-006).
		return (
			<div
				data-testid="preview-needs-llm"
				role="status"
				aria-label={`Recipe ${recipeId} requires LLM at apply time`}
				className="rounded border border-amber-300/30 bg-amber-300/5 px-4 py-4"
			>
				<p className="font-mono text-xs uppercase tracking-widest text-amber-200">requires an LLM at apply time</p>
				<p className="mt-2 text-sm text-neutral-300">
					This recipe is skipped during the registry dry-run. The engine will resolve it with an LLM when the plan is
					applied. The registry did not fabricate code for it.
				</p>
			</div>
		)
	}

	// `rendered` — fetch the full file contents lazily. The metadata
	// on the preview list is enough for the tile header; the bytes
	// arrive via the per-recipe endpoint.
	return <PreviewContent recipeId={recipeId} scope={scope} name={name} version={version} files={preview.files} />
}

function PreviewContent({
	recipeId,
	scope,
	name,
	version,
	files,
}: {
	recipeId: string
	scope: string
	name: string
	version: string
	files: RegistryPreviewEntry["files"]
}) {
	const [fullPreview, setFullPreview] = useState<RecipePreview | null>(null)
	const [error, setError] = useState<RegistryError | null>(null)
	const [loading, setLoading] = useState<boolean>(true)

	// Use the file list from the preview record as the initial
	// metadata; the per-recipe endpoint refines each entry with the
	// file bytes (content + size + sha256). When the server returns
	// no files (the recipe ran but wrote nothing), we render an
	// explicit "no files" message rather than an empty region.
	useEffect(() => {
		let aborted = false
		setLoading(true)
		setError(null)
		void getRecipePreview(scope, name, version, recipeId)
			.then((payload) => {
				if (aborted) return
				setFullPreview(payload)
				setLoading(false)
			})
			.catch((err: unknown) => {
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
			})
		return () => {
			aborted = true
		}
	}, [scope, name, version, recipeId])

	if (loading) {
		return (
			<div role="status" aria-live="polite" className="space-y-2">
				<div className="h-4 w-1/3 animate-pulse rounded bg-neutral-900" />
				<div className="h-32 w-full animate-pulse rounded bg-neutral-900" />
			</div>
		)
	}

	if (error !== null) {
		const isNotFound = error.code === "not-found"
		return (
			<div
				data-testid="preview-error"
				role="alert"
				className={cn(
					"rounded border px-4 py-3 text-sm",
					isNotFound
						? "border-neutral-800 bg-neutral-900/40 text-neutral-300"
						: "border-red-900/60 bg-red-950/30 text-red-200",
				)}
			>
				{isNotFound ? `No preview record for recipe "${recipeId}" on ${scope}/${name}@${version}.` : error.message}
			</div>
		)
	}

	if (fullPreview === null) return null

	// The full preview may carry a needs-llm payload with sentinel
	// files (the `{{!-- no-llm --}}` render path). In that case we
	// render the reason alongside the rendered template bytes.
	if (fullPreview.state === "needs-llm") {
		return (
			<div data-testid="preview-needs-llm" className="rounded border border-amber-300/30 bg-amber-300/5 px-4 py-4">
				<p className="font-mono text-xs uppercase tracking-widest text-amber-200">requires an LLM at apply time</p>
				{fullPreview.reason !== undefined && <p className="mt-2 text-sm text-neutral-300">{fullPreview.reason}</p>}
				{fullPreview.files !== undefined && fullPreview.files.length > 0 && (
					<div className="mt-4 space-y-3">
						<p className="font-mono text-xs uppercase tracking-widest text-neutral-500">
							Sentinel-rendered preview (no-llm template)
						</p>
						{fullPreview.files.map((file) => (
							<CodeFile key={file.path} file={file} />
						))}
					</div>
				)}
			</div>
		)
	}

	const filesToRender: ReadonlyArray<{ path: string; content?: string; size: number; sha256?: string }> =
		fullPreview.files ?? files ?? []
	if (filesToRender.length === 0) {
		return (
			<div
				data-testid="preview-empty"
				className="rounded border border-dashed border-neutral-800 bg-neutral-900/40 px-4 py-6 text-center"
			>
				<p className="text-sm text-neutral-300">The recipe ran but produced no files.</p>
			</div>
		)
	}

	return (
		<div data-testid="preview-files" className="space-y-3">
			{filePatternsSummary(filesToRender)}
			{filesToRender.map((file) => (
				<CodeFile key={file.path} file={file} />
			))}
		</div>
	)
}

function filePatternsSummary(files: ReadonlyArray<{ path: string }>) {
	if (files.length === 0) return null
	return (
		<p className="font-mono text-xs text-neutral-500">
			{files.length} {files.length === 1 ? "file" : "files"} in this preview
		</p>
	)
}

function CodeFile({ file }: { file: { path: string; content?: string; size: number; sha256?: string } }) {
	return (
		<div data-testid="preview-file" className="overflow-hidden rounded border border-neutral-800 bg-neutral-950">
			<header className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900 px-3 py-1.5 font-mono text-xs">
				<span className="text-neutral-100">{file.path}</span>
				<span className="text-neutral-500">
					{file.size} {file.size === 1 ? "byte" : "bytes"}
					{file.sha256 !== undefined && (
						<span className="ml-2 hidden sm:inline" title={file.sha256}>
							sha256:{file.sha256.slice(0, 8)}
						</span>
					)}
				</span>
			</header>
			{/* `whitespace-pre` keeps the registry-served bytes intact
			    (VAL-WEB-014: large previews fully rendered, no
			    truncation). The container has a max height with a
			    scrollbar so a 1000-line file does not blow up the
			    page. The page itself stays responsive: the scroll
			    is contained to the code block, not the document. */}
			<pre
				data-testid="preview-file-content"
				className="max-h-[32rem] overflow-auto bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-200 whitespace-pre"
			>
				{file.content ?? ""}
			</pre>
		</div>
	)
}

function readVersionFromLocation(): string | null {
	if (typeof window === "undefined") return null
	const params = new URLSearchParams(window.location.search)
	const value = params.get("version")
	if (value === null) return null
	const trimmed = value.trim()
	if (trimmed.length === 0) return null
	return trimmed
}
