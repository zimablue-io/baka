import { GetStarted } from "./GetStarted"
import { Hero } from "./Hero"
import { HowItWorks } from "./HowItWorks"
import { ModuleCatalog } from "./ModuleCatalog"
import { Problem } from "./Problem"

/**
 * The landing page composition (`/` route).
 *
 * The page is composed of the long-form sections that introduce the
 * product, with the registry-backed `ModuleCatalog` slot in the
 * middle. Splitting this from the route dispatcher in `App.tsx`
 * keeps the router tree trivial — only this file owns the
 * "marketing + catalog" layout.
 */
export function LandingPage() {
	return (
		<>
			<Hero />
			<Problem />
			<HowItWorks />
			<ModuleCatalog />
			<GetStarted />
		</>
	)
}
