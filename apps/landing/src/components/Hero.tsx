import logoDark from "@/assets/logo-dark.png"
import logoLight from "@/assets/logo-light.png"
import { cn } from "@/lib/cn"
import { SITE } from "@/lib/site"

export function Hero() {
	return (
		<section id="top" className="border-b border-neutral-800/60">
			<div className="mx-auto max-w-6xl px-6 py-24 sm:py-32 lg:py-30">
				<div className="mx-10 mb-10 flex items-center gap-3">
					<img
						src={logoLight}
						alt="baka"
						width={424}
						height={388}
						className="hidden h-20 w-auto sm:h-24 lg:size-72 dark:block"
					/>
					<img
						src={logoDark}
						alt="baka"
						width={424}
						height={388}
						className="block h-20 w-auto sm:h-24 lg:size-72 dark:hidden"
					/>
				</div>
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
