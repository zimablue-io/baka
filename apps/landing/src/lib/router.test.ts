// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getLocation, initRouter, matchPackDetail, matchResults, navigate, subscribeLocation } from "./router"

afterEach(() => {
	// Reset the singleton location between tests by setting the
	// history via navigate() and clearing listeners.
	window.history.replaceState({}, "", "/")
	window.dispatchEvent(new PopStateEvent("popstate"))
})

describe("matchPackDetail", () => {
	it("extracts scope and name from /packs/:scope/:name", () => {
		expect(matchPackDetail("/packs/acme/widget")).toEqual({
			scope: "acme",
			name: "widget",
		})
	})

	it("extracts scope and name from a scoped community pack", () => {
		expect(matchPackDetail("/packs/acme/widget")).toEqual({
			scope: "acme",
			name: "widget",
		})
	})

	it("tolerates a trailing slash", () => {
		expect(matchPackDetail("/packs/acme/widget/")).toEqual({
			scope: "acme",
			name: "widget",
		})
	})

	it("decodes percent-encoded scope and name", () => {
		expect(matchPackDetail("/packs/acme/weird%2Fname%20with%20spaces")).toEqual({
			scope: "acme",
			name: "weird/name with spaces",
		})
	})

	it("returns null for the landing page root", () => {
		expect(matchPackDetail("/")).toBeNull()
	})

	it("returns null for the catalog section anchor (#packs)", () => {
		expect(matchPackDetail("#packs")).toBeNull()
	})

	it("returns null when scope or name is missing", () => {
		expect(matchPackDetail("/packs/acme")).toBeNull()
		expect(matchPackDetail("/packs/")).toBeNull()
		expect(matchPackDetail("/packs/acme/")).toBeNull()
	})
})

describe("matchResults", () => {
	it("matches /results", () => {
		expect(matchResults("/results")).toBe(true)
		expect(matchResults("/results/")).toBe(true)
		expect(matchResults("/")).toBe(false)
	})
})

describe("navigate + popstate", () => {
	beforeEach(() => {
		// Reset the history location to "/" so tests start from a
		// known state. initRouter subscribes to popstate.
		window.history.replaceState({}, "", "/")
		initRouter()
	})

	it("updates getLocation() when navigate() is called", () => {
		navigate("/packs/acme/widget")
		expect(getLocation().pathname).toBe("/packs/acme/widget")
	})

	it("preserves the search and hash from the target path", () => {
		navigate("/packs/acme/widget?q=foo#preview")
		expect(getLocation().pathname).toBe("/packs/acme/widget")
		expect(getLocation().search).toBe("?q=foo")
		expect(getLocation().hash).toBe("#preview")
	})

	it("emits popstate-driven updates to subscribers", () => {
		const events: string[] = []
		subscribeLocation(() => {
			events.push(getLocation().pathname)
		})
		window.history.pushState({}, "", "/packs/acme/widget")
		window.dispatchEvent(new PopStateEvent("popstate"))
		expect(events).toContain("/packs/acme/widget")
	})

	it("does not emit when subscribers are unsubscribed", () => {
		const events: string[] = []
		const unsubscribe = subscribeLocation(() => {
			events.push(getLocation().pathname)
		})
		unsubscribe()
		navigate("/packs/acme/widget")
		expect(events).toEqual([])
	})
})
