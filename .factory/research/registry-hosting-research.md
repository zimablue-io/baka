# Registry Hosting Research: baka module registry

Date: 2026-07-27
Scope: hosting/distribution architecture options for baka modules (manifest JSON + Handlebars templates + TypeScript validator functions). Comparison of (a) pure GitHub-backed, (b) pure database/SaaS registry, (c) hybrid.

---

## 1. GitHub/VCS-backed distribution precedents

### Homebrew taps

- A tap is a plain git repo. `brew tap <user>/<repo>` clones `https://github.com/<user>/homebrew-<repo>`; two-arg form accepts any git URL. Naming convention (`homebrew-` prefix) is the only discovery mechanism for the shorthand form.
- Versioning: no native per-formula versioning. Installing a specific version from a third-party tap (`formula@1.5.1`) does not work the way users expect; version pinning requires extracting the formula at a git ref or hosting versioned formula files manually.
- Trust: Homebrew explicitly warns "code in a tap can run with your user's privileges". Tap Trust is per-formula / per-tap opt-in (`brew trust`), there is no signing of tap contents.
- Takeaway: VCS-backed distribution is trivial to bootstrap but versioning, trust, and discovery are all bolt-ons.
- Sources: https://docs.brew.sh/Taps, https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap, https://stackoverflow.com/questions/79029459/

### Claude Code plugin marketplaces

- A marketplace is a git repo (GitHub recommended) containing `.claude-plugin/marketplace.json`, a catalog listing plugins with `name` + `source`. Sources: relative path, `github` (owner/repo + ref/sha), `url` (any git), `git-subdir` (sparse clone for monorepos), `npm` (public or private registry).
- Versioning: if a plugin entry sets `version`, users only get updates when that field changes; otherwise every git commit counts as a new version (commit SHA is the pin). `sha` pinning survives branch/tag deletion on GitHub/GitLab/Bitbucket.
- Private/team sharing: works via existing git credential helpers (`gh auth login`, SSH agent). Caveats: background auto-update disables credential helpers for `git pull`, so private-repo auto-updates fail intermittently unless you set `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1`, configure URL rewrites, or update manually. Managed settings let org admins allowlist marketplaces (`strictKnownMarketplaces`).
- Trust: reserved-name list blocks impersonation of official marketplaces; no content signing.
- Takeaway: the closest existing analog to a baka registry (declarative catalog JSON + repo-hosted content + optional executable hooks). Shows the team-sharing story is workable but has sharp edges around background auth and offline environments.
- Sources: https://code.claude.com/docs/en/plugin-marketplaces, https://github.com/anthropics/claude-plugins-official, https://support.claude.com/en/articles/13837433

### Go modules (VCS-backed + proxy + checksum DB)

- Modules are fetched directly from VCS by default; `proxy.golang.org` is an optional caching mirror. `sum.golang.org` is a transparency log (Merkle tree) of module content hashes; the `go.sum` file pins expected hashes client-side. Since Go 1.13 the proxy + sumdb are the default path.
- Trust model: no publisher signing. Integrity comes from content hashing + the append-only transparency log, so a module's content can never silently change for a given version. `GOPRIVATE`/`GONOSUMDB`/`GONOSUMCHECK` carve out private modules that bypass proxy and sumdb entirely.
- Private/team sharing: VCS auth (SSH keys, `.netrc`, GitHub tokens) — no registry accounts at all. Version constraints and semver tags come free from git tags.
- Takeaway: the canonical hybrid. VCS remains source of truth; a stateless-ish metadata/integrity layer (proxy + sumdb) adds caching, immutability guarantees, and offline-ish resilience without owning the content.
- Sources: https://go.dev/blog/module-mirror-launch, https://proxy.golang.org/, https://sum.golang.org/, https://go.googlesource.com/proposal/+/master/design/25530-sumdb.md, https://safeguard.sh/resources/blog/go-module-checksum-database-in-depth

### JSR (Deno's registry)

- TypeScript-first, ESM-only registry. Version immutability enforced. Sigstore provenance built in (OIDC-token-based publishing from CI, no long-lived tokens). Has a package scoring system for quality/discovery. npm-compat layer so JSR packages are consumable from npm clients.
- Takeaway: shows a modern registry can be thin (no build step, stores source, generates docs) while still needing a DB, namespace claims, and provenance infra. Contrast with npm: the DB is unavoidable once you want namespacing + provenance + search.
- Sources: https://www.buildmvpfast.com/blog/should-you-publish-to-jsr-vs-npm-2026, https://www.pkgpulse.com/guides/npm-vs-jsr-package-registry-comparison-2026, https://www.infoworld.com/article/4124615/

### DevContainer features/templates

- Distribution via OCI registries (any registry implementing the OCI Artifact Distribution Spec, e.g. GHCR). Each feature/template is an OCI artifact (tarball) with `devcontainer-feature.json` metadata; individually semantically versioned (republished under major/minor/latest tags).
- Discovery: a namespace index (`devcontainer-collection.json`) plus a static-site index. GitHub is the source repo; GHCR is the artifact store.
- Takeaway: precedent for "git repo of source + OCI registry for versioned artifacts". Works well for opaque blobs; weaker for previewing generated output (baka's stated requirement), since an OCI artifact has no queryable metadata layer beyond tags.
- Sources: https://containers.dev/implementors/features-distribution/, https://containers.dev/implementors/templates-distribution/, https://deepwiki.com/devcontainers/spec/4-dev-container-templates

### Nix flakes

- A flake is a git repo with `flake.nix`; `flake.lock` pins exact input revisions + content hashes. Registry of symbolic names (`nixpkgs` etc.) is itself a git repo. Trust via content hashing + binary cache signatures (substituter signing keys).
- Takeaway: pure-git distribution with client-side lockfiles gives reproducibility without any central DB, but discovery is essentially nonexistent (the "registry" maps short names only).
- Sources: https://nixos.wiki/wiki/Flakes, https://nix.dev/concepts/flakes.html, https://nix.dev/manual/nix/2.18/command-ref/new-cli/nix3-flake-lock

### What breaks at scale (VCS-backed)

- Discovery/search: git hosts have no structured metadata index; every VCS-backed system above eventually grows a metadata layer (Go proxy, Claude marketplace JSON + claude.ai sync, Nix registry).
- Rate limits and availability: GitHub API/clone rate limits hit automated consumers; background updates against private repos are fragile (Claude Code's documented failure modes).
- Versioning semantics: git tags are mutable-ish and per-repo; nothing stops a publisher from retagging. You need hashes (go.sum, flake.lock) to make versions immutable.
- Namespace uniqueness: anyone can create `user/baka-modules`; there is no global claim on module names.

---

## 2. Database/SaaS-backed registry precedents

### npm registry

- Full DB-backed registry: scoped namespaces (`@org/pkg`), orgs with member/team roles, semver with immutability (unpublish restrictions), tarball storage, search.
- Monetization: free for public packages; paid org plans for private packages (per-user/month pricing on the Teams plan; enterprise tier with SSO/SAML). Sigstore provenance GA since 2023 (keyless, OIDC from CI).
- Sources: https://docs.npmjs.com/organizations/, https://www.npmjs.com/products, https://blog.sigstore.dev/npm-provenance-ga/

### VS Code marketplace

- Centralized SaaS catalog with publisher verification (verified domains), per-extension versioning, install metrics, and a review/report pipeline. Not self-hostable in practice (the reason Open VSX exists). Good discovery UX; fully closed governance.
- Source: https://code.visualstudio.com/blogs/2022/09/15/dev-container-features (adjacent), Open VSX docs.

### LangSmith Prompt Hub (prompt registry)

- SaaS prompt registry: public hub + private workspace-scoped prompts, commit-hash-based versioning with named tags (`prod`, `staging`), push/pull via SDK, tenant-level access control. Closest analog to "baka cloud": a DB registry of declarative-ish artifacts where private-by-default is the paid feature.
- Sources: https://docs.langchain.com/langsmith/manage-prompts, https://markaicode.com/langsmith-hub-prompt-templates/

### HashiCorp Terraform registry (public + HCP private)

- Public registry: namespaces, semver, docs rendering, search; modules/providers sourced from GitHub repos via webhooks (the registry is an index + artifact mirror over git tags).
- HCP Terraform private registry: org-scoped private modules/providers, searchable, versioned; can sync curated public modules into the org's private registry ("recommended" list); Sentinel policies can mandate private-registry usage and recent versions. Terraform Enterprise adds cross-org sharing.
- Takeaway: this is the exact monetization shape baka describes — free public registry, paid private org registry with policy enforcement — and it is implemented as a DB index over VCS sources.
- Sources: https://developer.hashicorp.com/terraform/cloud-docs/registry, https://developer.hashicorp.com/terraform/registry/private, https://spacelift.io/blog/terraform-private-registry, https://scalr.com/learning-center/explaining-a-terraform-private-module-registry

### Common DB-backed patterns

- Namespaces/orgs: global name claims scoped to verified orgs; team roles (owner/member/publisher).
- Versioning: immutable published versions, range resolution server-side.
- Access control: registry-issued tokens, OIDC trusted publishing, SSO on enterprise tiers.
- Monetization: public = free (ecosystem growth); private namespaces, seats, SSO/SAML, audit logs, policy enforcement = paid.

---

## 3. Security screening of community-published executable code

baka validators are TypeScript functions executed locally. That makes module installation equivalent to `npm install` with install scripts: the threat model is real and must be treated as supply-chain distribution of executable code, not data.

### What existing registries actually do

- npm: historically reactive (report + takedown), now layered: Sigstore provenance attestations, 2FA/token hardening (granular tokens, OIDC trusted publishing; per npm's products page, 2FA-bypass tokens restricted Aug 2026 and direct publishing restricted Jan 2027), audit API. Malware volume is huge (industry reports cite hundreds of thousands of malicious packages detected in 2025), so purely reactive is insufficient.
- Socket: proactive behavioral analysis of package contents (detects network/fs/env access, install scripts, obfuscation) at publish time; supply-chain alerts rather than CVE matching.
- Snyk: vulnerability database + static analysis; stronger on known-CVE detection than on novel malware.
- OpenSSF Scorecard: automated repo hygiene heuristics (branch protection, signed releases, pinned deps, token permissions) — useful as one signal in a screening score, not a malware detector.
- sigstore/cosign: keyless signing + Rekor transparency log; proves "this artifact was built by this CI identity", not "this code is safe". Composes well with a git-backed model (sign the manifest at publish).
- Sandboxed execution: registries generally do not execute uploaded code server-side; sandboxing is used by security vendors (and by CI) rather than by registries themselves. Human review is used by curated registries (VS Code marketplace reporting flow, MCP registry flag-via-GitHub-issues + maintainer denylist).
- Sources: https://getcommit.dev/blog/commit-vs-socket-snyk-npm-audit/, https://www.pkgpulse.com/guides/npm-vulnerability-management-snyk-socket-2026, https://blog.cyberdesserts.com/npm-security-vulnerabilities/, https://blog.sigstore.dev/npm-provenance-ga/, https://openssf.org/tag/sigstore/

### Realistic screening pipeline for baka modules

Because baka modules are manifest JSON + Handlebars templates + constrained TS validators (not arbitrary packages with dependency trees), the screening problem is much smaller than npm's:

1. Static analysis of validators at publish time: AST-level capability allowlist/denylist (deny `fs`, `child_process`, network imports, dynamic `import()`/`eval`, prototype pollution patterns). A validator should be a pure function over inputs; anything else is rejectable automatically.
2. Schema conformance: manifest validates against a strict JSON schema; templates compile with no unknown helpers (Handlebars helper allowlist — no user-registered helpers from untrusted code).
3. Sandboxed dry-run: execute validators in a locked-down runtime (Node `vm` with no host objects, or Deno with `--deny-all` then explicit allows; or a worker with seccomp/network namespace) against fixture inputs with time/memory limits. This doubles as the "preview what code a module would generate" feature — the same sandbox renders the templates.
4. Provenance: sigstore/cosign or GitHub Artifact Attestations binding the published module to a repo + commit + CI workflow.
5. Reputation/policy layer: publisher verification (GitHub OAuth org membership, domain proof like MCP registry's proposed DNS/TXT namespace validation), age/download signals, report-and-denylist moderation (MCP registry model).
6. Two-tier trust labels: `official` (baka team reviewed), `community-screened` (passed automated pipeline), `unverified` (local/git-sourced only, user opts in). This matches Homebrew's per-item trust and Claude Code's admin allowlisting.

The declarative majority of a module (manifest + templates) is data and cheap to trust; the validator functions are the entire attack surface, and their constrained shape makes automated screening tractable in a way it is not for npm packages.

---

## 4. Hybrid models

- Go modules: VCS is source of truth; proxy adds caching/availability, sumdb adds immutable integrity. Private path = plain VCS auth, zero registry dependency.
- MCP registry (official, launched preview Sept 8 2025): explicitly metadata-only. It is a discovery catalog (OpenAPI spec, namespace uniqueness + schema conformance validation only) that points at servers/packages hosted elsewhere (npm, PyPI, OCI, remote endpoints). Designed for federation: public and private subregistries reuse the same API contract and can enrich (ratings, audit info, policy). Moderation is community flagging + maintainer denylist. Trust boundary is metadata-level; no payload validation.
- Terraform public registry: DB index over GitHub repos (webhook-driven), artifact mirroring; private registry as the paid org-scoped layer.
- DevContainer: git source + OCI artifact store + static collection index.
- Claude Code marketplaces: git-hosted catalog JSON, with an optional SaaS sync surface (claude.ai) layered on top.

Pattern across all five: git remains the canonical artifact store (cheap, forkable, offline-friendly, OSS-native); a thin DB layer provides what git cannot — global namespaces, search/discovery, immutable version metadata, integrity hashes, provenance records, access control, and policy. The DB layer is where the paid product lives.
- Sources: https://workos.com/blog/mcp-registry-architecture-technical-overview, https://github.com/modelcontextprotocol/registry, https://modelcontextprotocol.io/registry/about, https://go.dev/blog/module-mirror-launch

---

## 5. Monetization precedents (brief)

- Open core / freemium cloud is the dominant dev-tool pattern (GitLab, Grafana, HashiCorp, LangChain): the OSS artifact + local workflow is fully free; the SaaS sells private namespaces/orgs, team seats, SSO/SAML, audit logs, policy enforcement, and hosting/availability.
- Registry-specific pricing: npm charges for private packages per member (Teams) and enterprise SSO; HCP Terraform bundles the private registry into org tiers; LangSmith makes private prompt workspaces the default paid boundary while the public hub is free.
- For baka this maps to: public community registry free (drives module ecosystem); paid cloud = private org registries, team sharing with RBAC, SSO, admin allowlists/policy (which modules teams may use, à la Claude Code managed settings + Terraform Sentinel), and hosted preview/screening infrastructure.
- Sources: https://www.reo.dev/blog/monetize-open-source-software, https://en.wikipedia.org/wiki/Open-core_model, https://www.npmjs.com/products, https://developer.hashicorp.com/terraform/cloud-docs/registry

---

## Synthesis

Comparison of the three architectures on the requested axes:

| Axis | (a) Pure GitHub-backed | (b) Pure DB/SaaS registry | (c) Hybrid (git source of truth + DB index) |
|---|---|---|---|
| Effort to build | Lowest. marketplace.json-style catalog + clone/pull. Weeks. | Highest. Storage, namespacing, tokens, search, billing, moderation. Months+. | Medium. Git path first; DB index is additive and can start as a generated static index. |
| Versioning/discovery quality | Weak versioning (tags mutable, no ranges), discovery needs conventions; hash pinning client-side fixes immutability. | Strong on both (semver ranges, immutable versions, search, metrics). | Strong: git tags + hashes for integrity, DB for search/metadata — the Go/Terraform/MCP pattern. |
| Private team sharing | Works today via git auth, but background-update auth and offline behavior are documented pain points (Claude Code). No org-level policy. | Best UX: orgs, RBAC, tokens, SSO, policy. Requires running the whole SaaS before any team can use it. | Git auth for private now; paid DB layer adds orgs/RBAC/policy later without breaking the OSS path. |
| Security pipeline fit | Screening must run in CI on the module repos or client-side; provenance via GitHub attestations. No central enforcement point. | Natural central enforcement point at publish; but you own the liability of hosting executable code. | Publish webhook/indexer runs the pipeline (static allowlist + sandboxed dry-run + provenance); unverified modules still installable from git with explicit opt-in. |
| Offline/OSS friendliness | Excellent. Forkable, mirrorable, no accounts, works airgapped. | Poor. Registry is a hard dependency; self-hosting a full SaaS is a big ask for OSS users. | Good. Core flow never requires the DB; DB outage degrades discovery, not installs (Go proxy model). |
| Monetization fit | Weak. Nothing to charge for; GitHub already provides hosting/auth. | Strong but all-or-nothing and capital-intensive. | Strong. Public index free; private org registry, SSO, policy, hosted preview = the paid tier (Terraform/npm/LangSmith shape). |

### Recommendation: hybrid (c), built in stages

1. Stage 1 (OSS, now): define a `baka registry` catalog format (a `registry.json` in a git repo, Claude Code marketplace-style), with git-based sources, `sha` pinning, and client-side content hashes in a lockfile. This ships team sharing immediately using existing git auth and costs almost nothing.
2. Stage 2 (still OSS): add the screening pipeline as a reusable CI action (manifest schema validation, validator AST capability allowlist, sandboxed dry-run that also powers the "preview generated code" feature, sigstore/GitHub attestation of results). Publish the screening verdict as machine-readable metadata in the catalog.
3. Stage 3 (cloud, later): add the thin DB index (MCP-registry-style: metadata + provenance + screening verdicts, pointing at git-hosted content). Free public community registry with the two-tier trust labels; paid tier = private org registries, RBAC, SSO, admin allowlists/policy, hosted previews.

Rationale: every successful precedent in this space that serves both OSS users and paying teams (Go, Terraform, MCP, DevContainer, Claude Code) converged on git-as-source-of-truth plus a metadata/integrity layer. Pure GitHub (a) leaves versioning, discovery, namespaces, and monetization unsolved; pure SaaS (b) is a heavy upfront build that hurts the OSS story and makes the registry a hard dependency. The hybrid lets baka ship value at each stage, keeps the executable-code screening problem tractable (validators are constrained pure functions, so an automated pipeline is realistic), and creates a natural paid boundary (private orgs + policy + hosted screening) without ever gating the core OSS workflow.
