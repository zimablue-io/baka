import { cn } from "@/lib/cn"
import { BRAND, BRAND_KANJI, SITE } from "@/lib/site"

export function Hero() {
	return (
		<section id="top" className="border-b border-neutral-800/60">
			<div className="mx-auto max-w-6xl px-6 py-24 sm:py-32 lg:py-40">
				<p className="mb-6 font-mono text-sm uppercase tracking-widest text-neutral-500">
					{BRAND} {BRAND_KANJI}
				</p>
				<h1 className="max-w-4xl text-balance text-4xl font-semibold tracking-tight text-neutral-50 sm:text-5xl lg:text-6xl">
					Sometimes, dumber is better.
				</h1>
				<p className="mt-6 max-w-2xl text-pretty text-lg text-neutral-400 sm:text-xl">
					A pattern-enforcement layer for LLM-assisted development. The LLM picks from a finite, declared action space —
					never invents one. Same intent, same modules, same plan, every time, on every model.
				</p>
				<div className="mt-10 flex flex-col gap-3 sm:flex-row">
					<a
						href="#get-started"
						className={cn(
							"inline-flex h-11 items-center justify-center rounded-md px-6 text-sm font-medium",
							"bg-neutral-50 text-neutral-950 transition-colors hover:bg-neutral-200",
						)}
					>
						Get started
					</a>
					<a
						href={SITE.github.blobUrl(SITE.docs.philosophy)}
						target="_blank"
						rel="noreferrer noopener"
						className={cn(
							"inline-flex h-11 items-center justify-center rounded-md px-6 text-sm font-medium",
							"border border-neutral-800 bg-neutral-900 text-neutral-100 transition-colors hover:bg-neutral-800",
						)}
					>
						Read the philosophy →
					</a>
				</div>
			</div>
		</section>
	)
}
