import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { Toaster } from "@/components/ui/toast"
import appCss from "../styles.css?url"

const APP_NAME = "baka lab"
const APP_DESCRIPTION = "Inspect packs, fill named slots, and hash trees against the local Hono engine."

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: APP_NAME },
			{ name: "description", content: APP_DESCRIPTION },
			{ name: "theme-color", content: "#171717" },
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
		],
	}),
	component: RootComponent,
})

function RootComponent() {
	return (
		<RootDocument>
			<Toaster>
				<Outlet />
			</Toaster>
		</RootDocument>
	)
}

function RootDocument({ children }: { children: ReactNode }) {
	return (
		<html lang="en" className="dark" suppressHydrationWarning>
			<head>
				<HeadContent />
			</head>
			<body>
				{children}
				<Scripts />
			</body>
		</html>
	)
}
