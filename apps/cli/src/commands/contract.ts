import { findBundledPacks } from "@baka/engine"
import { PackRegistry } from "@repo/ast-tooling"
import {
	BAKA_CAPABILITIES,
	BAKA_CONTRACT_VERSION,
	BAKA_EXIT_CODE,
	CONTRACT_DOCUMENT_IDS,
	contractJsonSchema,
	type Handshake,
	type Health,
	incompatibility,
	isContractDocumentId,
} from "@repo/protocol"
import { die } from "../die"

/**
 * `baka version`: the handshake a host runs before it uses this install. With `--require-contract`
 * and `--require`, it also answers whether this install meets the host's needs: exit 3 and the error
 * document when it does not.
 */
export function runVersionCommand(opts: {
	version: string
	json?: boolean
	requireContract?: string
	require?: string[]
}): void {
	let contract: number | undefined
	if (opts.requireContract !== undefined) {
		contract = Number(opts.requireContract)
		if (!Number.isInteger(contract) || contract < 0) {
			die(
				BAKA_EXIT_CODE.BAD_INPUT,
				`--require-contract expects a whole number (a contract major), got "${opts.requireContract}"`,
			)
		}
	}
	const handshake: Handshake = {
		schema: "baka.handshake/1",
		name: "baka",
		version: opts.version,
		contract: BAKA_CONTRACT_VERSION,
		capabilities: [...BAKA_CAPABILITIES],
		node: process.version,
	}
	const refusal = incompatibility({ contract, capabilities: opts.require })
	if (refusal)
		die(BAKA_EXIT_CODE.UNAVAILABLE, refusal.error.message, { code: refusal.error.code, hint: refusal.error.hint })
	console.log(
		opts.json ? JSON.stringify(handshake, null, 2) : `baka ${handshake.version} (contract ${handshake.contract})`,
	)
}

/** `baka health`: can this install do its job right now. Exit 3 when it cannot, with the checks that failed. */
export function runHealthCommand(opts: { cwd: string; json?: boolean; bundledPacksDir?: string }): void {
	const checks: Health["checks"] = []
	const nodeMajor = Number(process.versions.node.split(".")[0])
	checks.push({
		name: "node",
		ok: nodeMajor >= 20,
		detail:
			nodeMajor >= 20 ? `Node.js ${process.versions.node}` : `Node.js ${process.versions.node}; baka needs 20 or later`,
	})
	const bundled = opts.bundledPacksDir ?? findBundledPacks(import.meta.url)
	if (!bundled) {
		checks.push({ name: "starter-pack", ok: false, detail: "the bundled starter pack is missing from this install" })
	} else {
		const { packs, diagnostics } = new PackRegistry(opts.cwd, { packDirs: [bundled] }).discover(false)
		const broken = diagnostics.filter((d) => d.severity === "error")
		checks.push({
			name: "starter-pack",
			ok: packs.length > 0 && broken.length === 0,
			detail:
				broken.length > 0
					? `the bundled starter pack does not load: ${broken[0]?.message}`
					: `${packs.length} bundled pack(s) load from ${bundled}`,
		})
	}
	const ok = checks.every((c) => c.ok)
	const health: Health = { schema: "baka.health/1", ok, checks }
	if (opts.json) console.log(JSON.stringify(health, null, 2))
	else for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`)
	if (!ok) process.exit(BAKA_EXIT_CODE.UNAVAILABLE)
}

/** `baka schema [id]`: the ids of the published documents, or the JSON Schema of one. */
export function runSchemaCommand(id: string | undefined, opts: { json?: boolean }): void {
	if (id === undefined) {
		if (opts.json) console.log(JSON.stringify({ schemas: CONTRACT_DOCUMENT_IDS }, null, 2))
		else for (const known of CONTRACT_DOCUMENT_IDS) console.log(known)
		return
	}
	if (!isContractDocumentId(id)) {
		die(BAKA_EXIT_CODE.BAD_INPUT, `unknown document id "${id}"`, {
			code: "unknown-schema",
			hint: `Known ids: ${CONTRACT_DOCUMENT_IDS.join(", ")}`,
		})
	}
	console.log(JSON.stringify(contractJsonSchema(id), null, 2))
}
