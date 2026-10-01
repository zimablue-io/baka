import { Analytics } from "@vercel/analytics/react"
import { useEffect, useRef } from "react"
import { LandingPage } from "./components/LandingPage"
import { ModuleDetail } from "./components/ModuleDetail"
import { ResultsGallery } from "./components/ResultsGallery"
import { SiteFooter } from "./components/SiteFooter"
import { SiteHeader } from "./components/SiteHeader"
import { matchModuleDetail, matchResults, useLocation } from "./lib/router"

/**
 * App root. Two routes:
 *   - `/`                       — `LandingPage`
 *   - `/modules/:scope/:name`   — `ModuleDetail`
 *
 * The router (see `src/lib/router.ts`) is initialised once at mount;
 * subsequent navigation is pushState + popstate. On back-navigation
 * from the detail page to the catalog, the catalog component reads
 * its data from a singleton cache (see `src/lib/catalog-cache.ts`)
 * and its filter value from the URL — the user does not see a
 * loading state flash (VAL-WEB-009).
 */
export function App() {
	const location = useLocation()
	const detail = matchModuleDetail(location.pathname)
	const results = matchResults(location.pathname)

	// Scroll to the top on route change so a deep link to
	// `/modules/:scope/:name` does not inherit the previous page's
	// scroll position. The browser preserves the position on
	// `history.pushState` (annoying for detail pages), so we
	// explicitly reset it. We compare against the previous
	// pathname via a ref so this effect runs only when the path
	// actually changes, not on every location-object identity
	// swap from `useSyncExternalStore`.
	const prevPathnameRef = useRef(location.pathname)
	useEffect(() => {
		if (prevPathnameRef.current === location.pathname) return
		prevPathnameRef.current = location.pathname
		window.scrollTo({ top: 0, behavior: "auto" })
	})

	return (
		<div className="min-h-screen flex flex-col">
			<SiteHeader />
			<main className="flex-1">
				{detail === null ? (
					results ? (
						<ResultsGallery />
					) : (
						<LandingPage />
					)
				) : (
					<ModuleDetail scope={detail.scope} name={detail.name} />
				)}
			</main>
			<SiteFooter />
			<Analytics />
		</div>
	)
}
