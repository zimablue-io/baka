import { Input } from "@base-ui-components/react/input"
import { useMemo, useState } from "react"
import { modules } from "@/data/modules"
import { cn } from "@/lib/cn"
import { SITE } from "@/lib/site"

export function ModuleCatalog() {
	const [query, setQuery] = useState("")

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase()
		if (q === "") return modules
		return modules.filter((m) => m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q))
	}, [query])

	return (
		<section id="modules" className="border-b border-neutral-800/60 bg-neutral-900/30">
			<div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
				<div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
					<div className="max-w-2xl">
						<p className="mb-3 font-mono text-xs uppercase tracking-widest text-neutral-500">Module catalog</p>
						<h2 className="text-3xl font-semibold tracking-tight text-neutral-50 sm:text-4xl">
							Modules shipped with the engine.
						</h2>
						<p className="mt-3 text-neutral-400">
							Each module is a versioned, typed catalog of declared actions. The orchestrator can only pick from what
							these manifests expose.
						</p>
					</div>
					<div className="w-full sm:w-72">
						<label htmlFor="module-search" className="sr-only">
							Search modules
						</label>
						<Input
							id="module-search"
							placeholder="Search modules…"
							value={query}
							onValueChange={setQuery}
							className={cn(
								"h-10 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm",
								"text-neutral-100 placeholder:text-neutral-500",
								"focus:border-neutral-600 focus:outline-none focus:ring-2 focus:ring-neutral-700",
							)}
						/>
					</div>
				</div>

				<div className="overflow-hidden rounded-lg border border-neutral-800">
					<table className="w-full text-left text-sm">
						<thead className="bg-neutral-900 text-xs uppercase tracking-wider text-neutral-400">
							<tr>
								<th className="px-4 py-3 font-medium">Module</th>
								<th className="px-4 py-3 font-medium">Version</th>
								<th className="px-4 py-3 font-medium">Description</th>
								<th className="px-4 py-3 text-right font-medium">Actions</th>
								<th className="px-4 py-3 text-right font-medium">Source</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-neutral-800">
							{filtered.length === 0 ? (
								<tr>
									<td colSpan={5} className="px-4 py-10 text-center text-neutral-500">
										No modules match <span className="font-mono text-neutral-300">"{query}"</span>.
									</td>
								</tr>
							) : (
								filtered.map((m) => (
									<tr key={m.name} className="bg-neutral-950 transition-colors hover:bg-neutral-900">
										<td className="px-4 py-3 font-mono text-neutral-100">{m.name}</td>
										<td className="px-4 py-3 font-mono text-neutral-500">v{m.version}</td>
										<td className="px-4 py-3 text-neutral-400">{m.description}</td>
										<td className="px-4 py-3 text-right font-mono text-neutral-300">{m.actions}</td>
										<td className="px-4 py-3 text-right">
											<a
												href={SITE.github.treeUrl(m.path)}
												target="_blank"
												rel="noreferrer noopener"
												className="text-neutral-400 transition-colors hover:text-neutral-100"
											>
												view →
											</a>
										</td>
									</tr>
								))
							)}
						</tbody>
					</table>
				</div>

				<p className="mt-6 text-sm text-neutral-500">
					A community marketplace is coming. In the meantime, you can author your own with{" "}
					<code className="rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-neutral-300">
						{SITE.cli.moduleCreateHint()}
					</code>
					.
				</p>
			</div>
		</section>
	)
}
