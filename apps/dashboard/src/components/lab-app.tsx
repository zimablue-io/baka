"use client"

import { FolderIcon, Loader2Icon, PlayIcon } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"
import {
	defaultParamValues,
	ENGINE_URL,
	type EnginePack,
	type EnginePreview,
	fetchPacks,
	fetchPreview,
	fillSlot,
	paramsFromFields,
	runNamed,
} from "@/lib/engine"

type BodyTab = "write" | "templates" | "result"

function isBodyTab(value: unknown): value is BodyTab {
	return value === "write" || value === "templates" || value === "result"
}

export function LabApp() {
	const [project, setProject] = useState("")
	const [packs, setPacks] = useState<EnginePack[]>([])
	const [engineError, setEngineError] = useState<string | null>(null)
	const [selected, setSelected] = useState<{ pack: string; recipe: string } | null>(null)
	const [preview, setPreview] = useState<EnginePreview | null>(null)
	const [fields, setFields] = useState<Record<string, string>>({})
	const [slotFills, setSlotFills] = useState<Record<string, string>>({})
	const [result, setResult] = useState<string>("")
	const [bodyTab, setBodyTab] = useState<BodyTab>("write")
	const [busy, setBusy] = useState<"packs" | "preview" | "run" | null>(null)

	const selectedPack = useMemo(() => packs.find((m) => m.name === selected?.pack) ?? null, [packs, selected])

	const loadPacks = useCallback(async () => {
		setBusy("packs")
		try {
			const listed = await fetchPacks(project)
			setPacks(listed)
			setEngineError(null)
			setSelected(null)
			setPreview(null)
			setFields({})
			setSlotFills({})
			setResult("")
			setBodyTab("write")
			toast.add({ type: "success", title: listed.length ? `${listed.length} pack(s)` : "No packs in this project" })
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			setEngineError(message)
			setPacks([])
			toast.add({ type: "error", title: message })
		} finally {
			setBusy(null)
		}
	}, [project])

	const openRecipe = useCallback(
		async (packName: string, recipeId: string) => {
			setSelected({ pack: packName, recipe: recipeId })
			setBusy("preview")
			try {
				const next = await fetchPreview(project, packName, recipeId)
				setPreview(next)
				setFields(defaultParamValues(next.params ?? []))
				setSlotFills(Object.fromEntries((next.slots ?? []).map((s) => [s.id, ""])))
				setResult("")
				setBodyTab("write")
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				setPreview(null)
				toast.add({ type: "error", title: message })
			} finally {
				setBusy(null)
			}
		},
		[project],
	)

	const run = useCallback(async () => {
		if (!selected || !preview) return
		const missing = (preview.params ?? []).filter((p) => p.required && !(fields[p.name] ?? "").trim())
		if (missing.length > 0) {
			toast.add({ type: "error", title: `Required: ${missing.map((p) => p.name).join(", ")}` })
			return
		}
		setBusy("run")
		try {
			const params = paramsFromFields(fields, preview.params ?? [])
			for (const slot of preview.slots ?? []) {
				const value = (slotFills[slot.id] ?? "").trim()
				if (value) {
					await fillSlot(project, selected.pack, selected.recipe, slot.id, value, params)
				}
			}
			const body = await runNamed(project, selected.pack, selected.recipe, params)
			if (!body.ok) {
				throw new Error(body.error ?? body.diagnostics?.[0]?.message ?? "run failed")
			}
			const changes = body.changeset ?? []
			const summary = changes.length ? changes.map((e) => `${e.op}\t${e.path}`).join("\n") : "(no files)"
			const files = changes
				.filter((e) => e.content !== undefined)
				.map((e) => `--- ${e.path} ---\n${e.content}`)
				.join("\n\n")
			setResult(`${summary}\n\n${files}`)
			setBodyTab("result")
			toast.add({ type: "success", title: "Wrote files into the project" })
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			setResult(message)
			setBodyTab("result")
			toast.add({ type: "error", title: message })
		} finally {
			setBusy(null)
		}
	}, [fields, preview, project, selected, slotFills])

	return (
		<div className="flex h-svh flex-col overflow-hidden">
			<header className="flex shrink-0 flex-col gap-4 border-b px-6 py-4 lg:flex-row lg:items-end lg:justify-between">
				<div className="flex flex-col gap-1">
					<h1 className="font-heading text-lg font-medium tracking-tight">baka</h1>
					<p className="text-muted-foreground text-sm">
						Pick a project, pick an installed pack, fill its fields, see the templates, write the files.
					</p>
				</div>
				<div className="flex min-w-0 flex-1 flex-col gap-2 lg:max-w-xl">
					<Field>
						<FieldLabel htmlFor="project">Project folder</FieldLabel>
						<Input
							id="project"
							value={project}
							onChange={(e) => setProject(e.target.value)}
							placeholder="/absolute/path/to/baka/demo"
						/>
					</Field>
					<div className="flex items-center gap-2">
						<Badge variant={engineError ? "destructive" : "secondary"}>{ENGINE_URL}</Badge>
						<Button onClick={() => void loadPacks()} disabled={busy !== null}>
							{busy === "packs" ? (
								<Loader2Icon data-icon="inline-start" className="animate-spin" />
							) : (
								<FolderIcon data-icon="inline-start" />
							)}
							Load packs
						</Button>
					</div>
				</div>
			</header>

			<div className="grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-hidden p-6 lg:grid-cols-[minmax(260px,340px)_1fr]">
				<aside className="flex min-h-0 max-h-[40vh] flex-col lg:max-h-none">
					<Card size="sm" className="flex h-full min-h-0 flex-col">
						<CardHeader className="shrink-0 border-b">
							<CardTitle>Installed packs</CardTitle>
							<CardDescription>
								Whatever this project has in packs/, .baka/packs, or your user marketplace.
							</CardDescription>
						</CardHeader>
						<CardContent className="min-h-0 flex-1 overflow-hidden">
							<ScrollArea className="h-full">
								{packs.length === 0 ? (
									<Empty className="border py-8">
										<EmptyHeader>
											<EmptyTitle>None loaded</EmptyTitle>
											<EmptyDescription>
												Set the project folder to a real project (this repo's `demo/` folder works), start `baka serve`,
												then load.
											</EmptyDescription>
										</EmptyHeader>
									</Empty>
								) : (
									<div className="flex flex-col gap-4 pr-3 pb-1">
										{packs.map((mod) => (
											<div key={mod.name} className="flex flex-col gap-2">
												<div>
													<p className="font-medium">{mod.name}</p>
													<p className="text-muted-foreground text-sm">{mod.description ?? "No description."}</p>
												</div>
												<div className="flex flex-col gap-1">
													{mod.recipes.map((act) => (
														<Button
															key={act.id}
															size="sm"
															variant={
																selected?.pack === mod.name && selected.recipe === act.id ? "default" : "outline"
															}
															className="h-auto justify-start whitespace-normal py-2 text-left"
															onClick={() => void openRecipe(mod.name, act.id)}
														>
															<span className="flex flex-col gap-0.5">
																<span>{act.id}</span>
																{act.description ? (
																	<span className="font-normal text-muted-foreground text-xs">{act.description}</span>
																) : null}
															</span>
														</Button>
													))}
												</div>
											</div>
										))}
									</div>
								)}
							</ScrollArea>
						</CardContent>
					</Card>
				</aside>

				{preview && selected ? (
					<Card size="sm" className="flex h-full min-h-0 flex-col">
						<CardHeader className="shrink-0 border-b">
							<CardTitle>
								{selected.pack} / {selected.recipe}
							</CardTitle>
							<CardDescription>{preview.description ?? selectedPack?.description}</CardDescription>
						</CardHeader>
						<CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden">
							<Tabs
								value={bodyTab}
								onValueChange={(value) => {
									if (isBodyTab(value)) setBodyTab(value)
								}}
								className="flex min-h-0 flex-1 flex-col"
							>
								<TabsList className="w-full shrink-0">
									<TabsTrigger value="write">Write</TabsTrigger>
									<TabsTrigger value="templates">
										Templates{preview.files.length ? ` (${preview.files.length})` : ""}
									</TabsTrigger>
									<TabsTrigger value="result">Result</TabsTrigger>
								</TabsList>
								<TabsContent value="write" className="flex min-h-0 flex-col overflow-hidden">
									<div className="min-h-0 flex-1 overflow-hidden">
										<ScrollArea className="h-full">
											<FieldGroup className="pr-3 pb-1">
												{(preview.params ?? []).map((param) => (
													<Field key={param.name}>
														<FieldLabel htmlFor={`param-${param.name}`}>
															{param.name}
															{param.required ? " (required)" : ""}
														</FieldLabel>
														{param.description && param.description.length > 80 ? (
															<Textarea
																id={`param-${param.name}`}
																rows={4}
																value={fields[param.name] ?? ""}
																onChange={(e) => setFields((prev) => ({ ...prev, [param.name]: e.target.value }))}
															/>
														) : (
															<Input
																id={`param-${param.name}`}
																value={fields[param.name] ?? ""}
																onChange={(e) => setFields((prev) => ({ ...prev, [param.name]: e.target.value }))}
															/>
														)}
														{param.description ? <FieldDescription>{param.description}</FieldDescription> : null}
													</Field>
												))}
												{(preview.slots ?? []).map((slot) => (
													<Field key={slot.id}>
														<FieldLabel htmlFor={`slot-${slot.id}`}>Slot: {slot.id}</FieldLabel>
														<Textarea
															id={`slot-${slot.id}`}
															rows={3}
															value={slotFills[slot.id] ?? ""}
															onChange={(e) => setSlotFills((prev) => ({ ...prev, [slot.id]: e.target.value }))}
															placeholder={slot.hint ?? "Leave empty to let the worker model fill this hole."}
														/>
														<FieldDescription>
															{slot.kind}
															{slot.file ? ` in ${slot.file}` : ""}. Empty uses gemma on the engine if the recipe needs
															it.
														</FieldDescription>
													</Field>
												))}
											</FieldGroup>
										</ScrollArea>
									</div>
									<Button className="mt-3 shrink-0" onClick={() => void run()} disabled={busy !== null}>
										{busy === "run" ? (
											<Loader2Icon data-icon="inline-start" className="animate-spin" />
										) : (
											<PlayIcon data-icon="inline-start" />
										)}
										Write into project
									</Button>
								</TabsContent>
								<TabsContent value="templates" className="min-h-0 overflow-hidden">
									{preview.files.length === 0 ? (
										<p className="text-muted-foreground">This recipe has no templates (side-effect only).</p>
									) : (
										<ScrollArea className="h-full">
											<div className="flex flex-col gap-4 pr-3 pb-1">
												<p className="text-muted-foreground">
													Locked structure. Holes are named slots. Params interpolate.
												</p>
												{preview.files.map((file) => (
													<div key={file.rel} className="flex flex-col gap-2">
														<p className="font-mono text-xs">{file.rel}</p>
														<pre className="rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap">
															{file.source}
														</pre>
													</div>
												))}
											</div>
										</ScrollArea>
									)}
								</TabsContent>
								<TabsContent value="result" className="min-h-0 overflow-hidden">
									{result ? (
										<ScrollArea className="h-full">
											<pre className="pr-3 pb-1 font-mono text-xs whitespace-pre-wrap">{result}</pre>
										</ScrollArea>
									) : (
										<p className="text-muted-foreground">Write into the project to see files here.</p>
									)}
								</TabsContent>
							</Tabs>
						</CardContent>
					</Card>
				) : (
					<Empty className="h-full border py-16">
						<EmptyHeader>
							<EmptyTitle>Select a recipe</EmptyTitle>
							<EmptyDescription>
								The form and documents come from that pack. Switching recipes replaces the fields.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				)}
			</div>
		</div>
	)
}
