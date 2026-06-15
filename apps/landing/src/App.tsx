import { Analytics } from "@vercel/analytics/react"
import { GetStarted } from "./components/GetStarted"
import { Hero } from "./components/Hero"
import { HowItWorks } from "./components/HowItWorks"
import { ModuleCatalog } from "./components/ModuleCatalog"
import { Problem } from "./components/Problem"
import { SiteFooter } from "./components/SiteFooter"
import { SiteHeader } from "./components/SiteHeader"

export function App() {
	return (
		<div className="min-h-screen flex flex-col">
			<SiteHeader />
			<main className="flex-1">
				<Hero />
				<Problem />
				<HowItWorks />
				<ModuleCatalog />
				<GetStarted />
			</main>
			<SiteFooter />
			<Analytics />
		</div>
	)
}
