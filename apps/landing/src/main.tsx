import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import "./index.css"
import { initRouter } from "./lib/router"

const rootElement = document.getElementById("root")
if (!rootElement) throw new Error("root element not found")

// Wire up popstate + the in-app <a data-link> interceptor before
// React mounts, so the first render reads the correct location.
initRouter()

createRoot(rootElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
