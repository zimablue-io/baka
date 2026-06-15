import { cn } from "@/lib/cn"

const TIERS = [
	{
		name: "Orchestrator",
		role: "LLM (high reasoning)",
		body: "Receives the user intent and the full module manifest catalog. Emits a validated sequence of {module, action, params} steps. The catalog is the only allowed source — anything not declared is a hard error.",
		accent: "text-amber-300",
	},
	{
		name: "Worker",
		role: "Dumb automation (+ optional small-LLM assist)",
		body: "Dispatches one declared action to a deterministic TypeScript handler. When requiresReasoning is true, a small LLM fills the body of a template the module controls. The file path, exports, and surrounding code are dictated by the template — never invented.",
		accent: "text-emerald-300",
	},
	{
		name: "Validator",
		role: "Deterministic TypeScript",
		body: "Runs the module's _shared/validators/*.ts and action validators/*.ts against the resulting file tree. No LLM in the hot path. Returns Pass or Fail(diff[]) with structured diagnostics.",
		accent: "text-sky-300",
	},
] as const

export function HowItWorks() {
	return (
		<section id="how-it-works" className="border-b border-neutral-800/60">
			<div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
				<div className="mb-12 max-w-2xl">
					<p className="mb-3 font-mono text-xs uppercase tracking-widest text-neutral-500">How it works</p>
					<h2 className="text-3xl font-semibold tracking-tight text-neutral-50 sm:text-4xl">
						Three tiers. The LLM is the orchestrator, not the author.
					</h2>
				</div>

				{/* Hand-rolled SVG diagram — no Mermaid runtime dep. */}
				<div className="mb-16 overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-900/40 p-6 sm:p-10">
					<svg
						role="img"
						aria-label="Three-tier flow: user intent flows into the Orchestrator LLM, which picks from the catalog and dispatches to the Worker. The Worker hands the file tree to the Validator, which returns Pass or Fail."
						viewBox="0 0 900 200"
						className="mx-auto h-auto w-full max-w-3xl"
					>
						<defs>
							<marker
								id="arrow"
								viewBox="0 0 10 10"
								refX="9"
								refY="5"
								markerWidth="6"
								markerHeight="6"
								orient="auto-start-reverse"
							>
								<path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" className="text-neutral-600" />
							</marker>
						</defs>
						<g fontFamily="ui-sans-serif, system-ui, sans-serif" fontSize="14">
							<FlowNode x={10} y={70} label="User intent" sub="text" />
							<FlowNode x={200} y={70} label="Orchestrator" sub="LLM" highlight="amber" />
							<FlowNode x={400} y={70} label="Worker" sub="dumb + small LLM" highlight="emerald" />
							<FlowNode x={600} y={70} label="Validator" sub="deterministic TS" highlight="sky" />
							<FlowNode x={790} y={70} label="File tree" sub="Pass / Fail" />
							<line
								x1={130}
								y1={100}
								x2={195}
								y2={100}
								stroke="currentColor"
								strokeWidth={1.5}
								className="text-neutral-600"
								markerEnd="url(#arrow)"
							/>
							<line
								x1={330}
								y1={100}
								x2={395}
								y2={100}
								stroke="currentColor"
								strokeWidth={1.5}
								className="text-neutral-600"
								markerEnd="url(#arrow)"
							/>
							<line
								x1={530}
								y1={100}
								x2={595}
								y2={100}
								stroke="currentColor"
								strokeWidth={1.5}
								className="text-neutral-600"
								markerEnd="url(#arrow)"
							/>
							<line
								x1={730}
								y1={100}
								x2={785}
								y2={100}
								stroke="currentColor"
								strokeWidth={1.5}
								className="text-neutral-600"
								markerEnd="url(#arrow)"
							/>
						</g>
					</svg>
				</div>

				<div className="grid gap-px bg-neutral-800/60 lg:grid-cols-3">
					{TIERS.map((tier) => (
						<div key={tier.name} className="bg-neutral-950 p-6 sm:p-8">
							<div className="flex items-baseline justify-between">
								<h3 className={cn("text-lg font-semibold", tier.accent)}>{tier.name}</h3>
								<span className="font-mono text-xs uppercase tracking-wider text-neutral-500">{tier.role}</span>
							</div>
							<p className="mt-4 text-sm leading-relaxed text-neutral-400">{tier.body}</p>
						</div>
					))}
				</div>
			</div>
		</section>
	)
}

function FlowNode({
	x,
	y,
	label,
	sub,
	highlight,
}: {
	x: number
	y: number
	label: string
	sub: string
	highlight?: "amber" | "emerald" | "sky"
}) {
	const fill = highlight
		? highlight === "amber"
			? "fill-amber-300/10 stroke-amber-300/40"
			: highlight === "emerald"
				? "fill-emerald-300/10 stroke-emerald-300/40"
				: "fill-sky-300/10 stroke-sky-300/40"
		: "fill-neutral-900 stroke-neutral-700"
	return (
		<g>
			<rect x={x} y={y} width={130} height={60} rx={8} className={fill} strokeWidth={1.5} />
			<text x={x + 65} y={y + 28} textAnchor="middle" className="fill-neutral-100 font-semibold">
				{label}
			</text>
			<text x={x + 65} y={y + 46} textAnchor="middle" className="fill-neutral-500 font-mono" fontSize={11}>
				{sub}
			</text>
		</g>
	)
}
