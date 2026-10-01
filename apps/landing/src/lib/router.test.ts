// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getLocation, initRouter, matchModuleDetail, matchResults, navigate, subscribeLocation } from "./router"

afterEach(() => {
	// Reset the singleton location between tests by setting the
	// history via navigate() and clearing listeners.
	window.history.replaceState({}, "", "/")
	window.dispatchEvent(new PopStateEvent("popstate"))
})

describe("matchModuleDetail", () => {
	it("extracts scope and name from /modules/:scope/:name", () => {
		expect(matchModuleDetail("/modules/acme/widget")).toEqual({
			scope: "acme",
			name: "widget",
		})
	})

	it("extracts scope and name from a scoped community module", () => {
		expect(matchModuleDetail("/modules/acme/widget")).toEqual({
			scope: "acme",
			name: "widget",
		})
	})

	it("tolerates a trailing slash", () => {
		expect(matchModuleDetail("/modules/acme/widget/")).toEqual({
			scope: "acme",
			name: "widget",
		})
	})

	it("decodes percent-encoded scope and name", () => {
		expect(matchModuleDetail("/modules/acme/weird%2Fname%20with%20spaces")).toEqual({
			scope: "acme",
			name: "weird/name with spaces",
		})
	})

	it("returns null for the landing page root", () => {
		expect(matchModuleDetail("/")).toBeNull()
	})

	it("returns null for the catalog section anchor (#modules)", () => {
		expect(matchModuleDetail("#modules")).toBeNull()
	})

	it("returns null when scope or name is missing", () => {
		expect(matchModuleDetail("/modules/acme")).toBeNull()
		expect(matchModuleDetail("/modules/")).toBeNull()
		expect(matchModuleDetail("/modules/acme/")).toBeNull()
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
		navigate("/modules/acme/widget")
		expect(getLocation().pathname).toBe("/modules/acme/widget")
	})

	it("preserves the search and hash from the target path", () => {
		navigate("/modules/acme/widget?q=foo#preview")
		expect(getLocation().pathname).toBe("/modules/acme/widget")
		expect(getLocation().search).toBe("?q=foo")
		expect(getLocation().hash).toBe("#preview")
	})

	it("emits popstate-driven updates to subscribers", () => {
		const events: string[] = []
		subscribeLocation(() => {
			events.push(getLocation().pathname)
		})
		window.history.pushState({}, "", "/modules/acme/widget")
		window.dispatchEvent(new PopStateEvent("popstate"))
		expect(events).toContain("/modules/acme/widget")
	})

	it("does not emit when subscribers are unsubscribed", () => {
		const events: string[] = []
		const unsubscribe = subscribeLocation(() => {
			events.push(getLocation().pathname)
		})
		unsubscribe()
		navigate("/modules/acme/widget")
		expect(events).toEqual([])
	})
})
