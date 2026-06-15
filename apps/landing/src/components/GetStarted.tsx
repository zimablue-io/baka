import { useState } from "react"
import { cn } from "@/lib/cn"
import { BRAND, SITE } from "@/lib/site"

const STEPS = [
	{
		title: "Clone and install",
		body: `Get the ${BRAND} engine locally. The CLI is published as a workspace package; you run it via pnpm.`,
		command: `git clone ${SITE.github.cloneUrl}\ncd ${SITE.github.repo}\npnpm install`,
	},
	{
		title: "Set up a provider",
		body: `Pick an OpenAI-compatible endpoint (llama.cpp, Ollama, vLLM, OpenAI, anything speaking chat-completions). ${BRAND} init is interactive.`,
		command: `pnpm ${BRAND} init`,
	},
	{
		title: "Plan your first feature",
		body: "Pass an intent; the orchestrator returns a {module, action, params} plan. Dry-run first, then apply.",
		command: `pnpm ${BRAND} plan "add a Better-Auth setup with Google login"`,
	},
] as const

export function GetStarted() {
	return (
		<section id="get-started" className="border-b border-neutral-800/60">
			<div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
				<div className="mb-12 max-w-2xl">
					<p className="mb-3 font-mono text-xs uppercase tracking-widest text-neutral-500">Get started</p>
					<h2 className="text-3xl font-semibold tracking-tight text-neutral-50 sm:text-4xl">
						Three commands. The wheel stops spinning.
					</h2>
					<p className="mt-4 text-neutral-400">
						{BRAND} runs locally. The CLI is the binary; the engine is the package. Configure your provider, then plan
						and apply.
					</p>
				</div>
				<ol className="space-y-6">
					{STEPS.map((step, i) => (
						<li key={step.title} className="rounded-lg border border-neutral-800 bg-neutral-900/40">
							<div className="flex items-start gap-4 p-6">
								<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-neutral-700 font-mono text-sm text-neutral-300">
									{i + 1}
								</span>
								<div className="min-w-0 flex-1">
									<h3 className="text-lg font-semibold text-neutral-100">{step.title}</h3>
									<p className="mt-1 text-sm text-neutral-400">{step.body}</p>
									<CodeBlock code={step.command} />
								</div>
							</div>
						</li>
					))}
				</ol>
			</div>
		</section>
	)
}

function CodeBlock({ code }: { code: string }) {
	const [copied, setCopied] = useState(false)
	const onCopy = async () => {
		try {
			await navigator.clipboard.writeText(code)
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		} catch {
			// Clipboard may be unavailable in non-secure contexts; fail silently.
		}
	}
	return (
		<div className="relative mt-4 overflow-hidden rounded-md border border-neutral-800 bg-neutral-950">
			<button
				type="button"
				onClick={onCopy}
				aria-label="Copy command"
				className={cn(
					"absolute right-2 top-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1",
					"font-mono text-xs text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100",
				)}
			>
				{copied ? "copied" : "copy"}
			</button>
			<pre className="overflow-x-auto p-4 pr-16 font-mono text-sm text-neutral-200">
				<code>{code}</code>
			</pre>
		</div>
	)
}
