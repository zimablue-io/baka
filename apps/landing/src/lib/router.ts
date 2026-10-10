import { useSyncExternalStore } from "react"

/**
 * Minimal client-side router for the landing app.
 *
 * The landing is a single-route SPA; we only need two locations:
 *   - `/`                     — the landing page (hero + catalog + ...)
 *   - `/packs/:scope/:name` — the pack detail page
 *
 * We deliberately avoid `react-router` here: the route surface is
 * small, the existing app does not depend on it, and the assertion
 * suite (VAL-WEB-009) only needs pushState navigation + filter
 * preservation across back/forward. The router is responsible for:
 *
 *   1. Reporting the current location (pathname + search) to
 *      subscribers.
 *   2. Pushing a new location via `history.pushState`.
 *   3. Listening to `popstate` so browser back/forward updates the
 *      UI.
 *
 * State (catalog cache, filter value) lives outside the router —
 * the router only moves the URL.
 */

interface RouterLocation {
	readonly pathname: string
	readonly search: string
	readonly hash: string
}

const listeners = new Set<() => void>()

function readLocation(): RouterLocation {
	if (typeof window === "undefined") {
		return { pathname: "/", search: "", hash: "" }
	}
	const pathname = window.location.pathname || "/"
	const search = window.location.search || ""
	const hash = window.location.hash || ""
	return { pathname, search, hash }
}

let current: RouterLocation = readLocation()

function emit(): void {
	for (const listener of listeners) listener()
}

/**
 * Subscribes the router to `popstate` (back/forward navigation) and
 * `click` events on `<a data-link>` elements. Call once at app boot.
 *
 * The click handler is a tiny progressive enhancement: a real anchor
 * with `data-link` is intercepted and replaced with `pushState` so
 * the URL updates without a full page reload. This keeps deep links
 * working (right-click "Open in new tab" still copies the real URL)
 * while making in-app navigation instant.
 *
 * External links (target=_blank, different origin, modifier keys) are
 * left alone so the browser handles them natively.
 */
export function initRouter(): void {
	if (typeof window === "undefined") return
	window.addEventListener("popstate", () => {
		current = readLocation()
		emit()
	})
	window.addEventListener("click", (event) => {
		if (event.defaultPrevented) return
		if (event.button !== 0) return
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
		const target = event.target
		if (!(target instanceof Element)) return
		const anchor = target.closest("a")
		if (!(anchor instanceof HTMLAnchorElement)) return
		const href = anchor.getAttribute("href")
		if (href === null || href.length === 0) return
		if (anchor.target && anchor.target !== "" && anchor.target !== "_self") return
		if (anchor.hasAttribute("download")) return
		if (anchor.dataset.link === "external") return
		let url: URL
		try {
			url = new URL(href, window.location.origin)
		} catch {
			return
		}
		if (url.origin !== window.location.origin) return
		event.preventDefault()
		const nextPath = `${url.pathname}${url.search}${url.hash}`
		navigate(nextPath)
	})
}

export function navigate(path: string): void {
	if (typeof window === "undefined") return
	window.history.pushState({}, "", path)
	current = readLocation()
	emit()
}

export function getLocation(): RouterLocation {
	return current
}

export function subscribeLocation(listener: () => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

/**
 * React hook returning `{ pathname, search, hash }`. Re-renders the
 * caller when the location changes (pushState, popstate, click).
 */
export function useLocation(): RouterLocation {
	return useSyncExternalStore(subscribeLocation, getLocation, getLocation)
}

interface PackMatch {
	readonly scope: string
	readonly name: string
}

/**
 * Matches `/packs/:scope/:name` against a pathname. Trailing slash
 * is tolerated. Returns `null` when the path does not match — the
 * caller falls back to the landing page.
 */
export function matchResults(pathname: string): boolean {
	return pathname === "/results" || pathname === "/results/"
}

export function matchPackDetail(pathname: string): PackMatch | null {
	const match = pathname.match(/^\/packs\/([^/]+)\/([^/]+)\/?$/)
	if (match === null) return null
	const [, scopeRaw, nameRaw] = match
	if (scopeRaw === undefined || nameRaw === undefined) return null
	let scope: string
	let name: string
	try {
		scope = decodeURIComponent(scopeRaw)
		name = decodeURIComponent(nameRaw)
	} catch {
		return null
	}
	if (scope.length === 0 || name.length === 0) return null
	return { scope, name }
}
