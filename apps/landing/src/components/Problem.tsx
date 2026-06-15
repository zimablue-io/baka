import { cn } from "@/lib/cn"

const PROBLEMS = [
	{
		title: "Every project looks different.",
		body: "The same auth, the same error handling, the same TypeScript module — written a thousand subtly different ways, by the same model, on the same day.",
	},
	{
		title: "Wheels get re-invented.",
		body: "Every LLM invocation re-decides your file tree from scratch. The model re-invents the wheel constantly, and no two runs produce the same structure.",
	},
	{
		title: "Nothing is auditable.",
		body: "When the model invents the file layout, you can't review it — because the structure was never yours to begin with. The plan is opaque and the diff is novel every time.",
	},
] as const

export function Problem() {
	return (
		<section id="problem" className="border-b border-neutral-800/60 bg-neutral-900/30">
			<div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
				<div className="mb-12 max-w-2xl">
					<p className="mb-3 font-mono text-xs uppercase tracking-widest text-neutral-500">The problem</p>
					<h2 className="text-3xl font-semibold tracking-tight text-neutral-50 sm:text-4xl">
						LLM-assisted development has a specific failure mode.
					</h2>
					<p className="mt-4 text-neutral-400">
						Modern LLM-assisted development asks the model to invent code, files, and structure from scratch, every
						time, on every project. The model re-invents the wheel — and your team is the one left cleaning up after it.
					</p>
				</div>
				<div className="grid gap-px bg-neutral-800/60 sm:grid-cols-3">
					{PROBLEMS.map((p) => (
						<div key={p.title} className="bg-neutral-950 p-6 sm:p-8">
							<h3 className="text-lg font-semibold text-neutral-100">{p.title}</h3>
							<p className={cn("mt-3 text-sm leading-relaxed text-neutral-400")}>{p.body}</p>
						</div>
					))}
				</div>
			</div>
		</section>
	)
}
