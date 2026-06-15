import { cn } from "@/lib/cn"
import { BRAND, SITE } from "@/lib/site"

const FOOTER_LINKS = [
	{ href: SITE.github.url, label: "GitHub", external: true },
	{ href: SITE.github.blobUrl(SITE.docs.philosophy), label: "Philosophy", external: true },
	{ href: SITE.github.blobUrl(SITE.docs.modules), label: "Module authoring", external: true },
	{ href: SITE.github.blobUrl(SITE.docs.agent), label: "Agent guide", external: true },
] as const

export function SiteFooter() {
	return (
		<footer className="border-t border-neutral-800/60 bg-neutral-950">
			<div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex items-center gap-3">
					<span className="font-mono text-sm text-neutral-400">{BRAND}</span>
					<span className="text-neutral-700">·</span>
					<span className="text-sm text-neutral-500">© {new Date().getFullYear()}</span>
				</div>
				<nav className="flex flex-wrap gap-x-6 gap-y-2">
					{FOOTER_LINKS.map((link) => (
						<a
							key={link.href}
							href={link.href}
							{...(link.external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
							className={cn("text-sm text-neutral-400 transition-colors hover:text-neutral-100")}
						>
							{link.label}
						</a>
					))}
				</nav>
			</div>
		</footer>
	)
}
