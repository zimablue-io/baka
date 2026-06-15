import { cn } from "@/lib/cn"
import { BRAND, SITE } from "@/lib/site"

const NAV_LINKS = [
	{ href: "#problem", label: "Problem" },
	{ href: "#how-it-works", label: "How it works" },
	{ href: "#modules", label: "Modules" },
	{ href: "#get-started", label: "Get started" },
] as const

export function SiteHeader() {
	return (
		<header
			className={cn(
				"sticky top-0 z-50 w-full border-b border-neutral-800/60",
				"bg-neutral-950/80 backdrop-blur supports-[backdrop-filter]:bg-neutral-950/60",
			)}
		>
			<div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
				<a href="#top" className="font-mono text-lg font-semibold tracking-tight text-neutral-100">
					{BRAND}
					<span className="text-neutral-500">.</span>
				</a>
				<nav className="hidden gap-6 md:flex">
					{NAV_LINKS.map((link) => (
						<a
							key={link.href}
							href={link.href}
							className="text-sm text-neutral-400 transition-colors hover:text-neutral-100"
						>
							{link.label}
						</a>
					))}
				</nav>
				<a
					href={SITE.github.url}
					target="_blank"
					rel="noreferrer noopener"
					className="text-neutral-400 transition-colors hover:text-neutral-100"
				>
					<span className="sr-only">GitHub repository</span>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 24 24"
						fill="currentColor"
						className="h-5 w-5"
						aria-hidden="true"
					>
						<title>GitHub</title>
						<path
							fillRule="evenodd"
							clipRule="evenodd"
							d="M12 2C6.475 2 2 6.475 2 12a9.994 9.994 0 0 0 6.838 9.488c.5.087.687-.213.687-.476 0-.237-.013-1.024-.013-1.862-2.512.463-3.162-.612-3.362-1.175-.113-.288-.6-1.175-1.025-1.413-.35-.187-.85-.65-.013-.662.788-.013 1.35.725 1.538 1.025.9 1.512 2.338 1.087 2.912.825.088-.65.35-1.087.638-1.337-2.225-.25-4.55-1.113-4.55-4.938 0-1.088.387-1.987 1.025-2.688-.1-.25-.45-1.275.1-2.65 0 0 .837-.262 2.75 1.026a9.28 9.28 0 0 1 2.5-.338c.85 0 1.7.112 2.5.337 1.912-1.3 2.75-1.024 2.75-1.024.55 1.375.2 2.4.1 2.65.637.7 1.025 1.587 1.025 2.687 0 3.838-2.337 4.688-4.562 4.938.362.312.675.912.675 1.85 0 1.337-.013 2.412-.013 2.75 0 .262.188.574.688.474A10.016 10.016 0 0 0 22 12c0-5.525-4.475-10-10-10Z"
						/>
					</svg>
				</a>
			</div>
		</header>
	)
}
