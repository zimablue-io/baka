# Evidence-First Coding

**Owner**: Platform Team
**Last Updated**: 2026-06-11
**Applies to**: All code changes (any language, any package in this monorepo).

## Read the codebase before writing code

**Rule**: Before proposing or writing any code change, gather evidence
in this order. Refusal to follow is itself a rule violation.

1. Read the root `AGENTS.md` and the relevant package's `AGENTS.md`.
2. Grep and Read the actual files the change will touch. Cite
   `file:line` for every claim about the existing code.
3. For every external library involved (Next.js, React, oRPC, Vercel
   AI SDK, Drizzle, Zod, Biome, better-sqlite3, etc.), call
   `mcp__context7__resolve-library-id` and
   `mcp__context7__query-docs` to verify the *current* API. Cite
   the doc URL.
4. Web search only if Context7 is silent or the package version in
   `package.json` / `pyproject.toml` is not covered. Cite the
   source.
5. State the causal chain explicitly: "I will change X in file Y
   because Z happens; the root cause is W." This is the Root
   Cause Gate from the root `AGENTS.md`. Do not skip it.

**Rationale**: LLM training cutoffs lag the actual library releases
by 12-24 months for fast-moving libraries (Next.js, Vercel AI SDK,
Biome). The most common way the model produces a bad recommendation
is by trusting memory instead of fetching docs. The most common
way it produces a bad recommendation in a specific repo is by not
reading the existing patterns in that repo.

## Common rationalizations to reject

- "Training data already covers this library." — It does not. Use
  Context7.
- "The code is simple." — Simple code still benefits from cited
  context, especially when the team has had to push back on
  recurring mistakes.
- "The user said it's obvious." — Obvious to the user is exactly
  what we have been getting wrong.
- "I'll add tests after." — See `tdd.md`.

## Verification Is the Binary Actually Running, Not Just Tests Passing

**Applies to**: All changes to runtime user-facing code, especially
TUI / CLI / desktop / dashboard apps where the unit test env
diverges from the real env (ESM vs CJS polyfill, jsdom vs node,
ink-testing-library vs a real TTY, vitest's `require` polyfill
vs Node ESM's lack thereof).

**Rule**: A green test run is necessary but not sufficient for
"this works." A test that asserts `expect(() => render(...)).not.toThrow()`
in a vitest/jsdom environment proves the SOURCE doesn't throw
in that env. It does NOT prove the BINARY doesn't crash at
runtime in a real TTY. For runtime user-facing code, the proof
is the binary actually running end-to-end with a real TTY and a
real sign-in / real data — and the user-visible output
demonstrating the expected state. "I ran the unit tests and
they passed" is not verification when the bug was a runtime
crash that the unit-test env masked.

```ts
// ❌ Avoid: claiming the bug is fixed because the unit tests
// pass, when the unit-test env has a CJS polyfill for
// `require` that the real ESM binary does not have. The
// user's binary still crashes with
//   ReferenceError: require is not defined
//   at RetryingInput (BackendsScreen.tsx:139:24)
// and the unit tests are GREEN.
it('renders without throwing', () => {
  expect(() => render(<BackendsScreen ... />)).not.toThrow()
  // → passes in vitest (CJS polyfill)
  // → fails at runtime in real Node ESM
})
```

```ts
// ✅ Correct: prove the bug is gone in REAL ESM by either
//   (a) running the binary end-to-end with a real TTY and
//       asserting the user-visible output, or
//   (b) adding a static check that catches the pattern
//       (no `require(` in the source file) and a real-Node
//       import that fails closed if the source loads with
//       a CJS-only construct.
it('source file does not use require() (ESM-only)', () => {
  expect(readFileSync(sourcePath, 'utf8')).not.toMatch(/=\s*require\s*\(\s*['"]/)
})

it('imports useInput at the top level (not lazy-require)', () => {
  expect(source).toMatch(/import\s*\{[^}]*\buseInput\b[^}]*\}\s*from\s*['"]ink['"]/)
})
```

```bash
# ✅ Correct: end-to-end binary run as the verification gate
# Run the binary in a real PTY, capture the output, assert
# the user-visible screen. If "ReferenceError" appears in
# the output, the bug is still present.
script -q /tmp/binary.log -c "DASHBOARD_BASE_URL=... KABU_ORG_API_KEY=... node bin/kabu.mjs" < /dev/null
grep -E "ReferenceError|require is not defined" /tmp/binary.log
# → empty: bug is fixed
```

**Rationale**: The user has repeated the same frustration
("WHY ARE YOU STILL NOT RUNNING ANY TESTS?!?!?") across
multiple sessions when the model claims completion based on
green unit tests alone, while the real binary crashes. The
recurring failure mode is: vitest's CJS-like env exposes
`require` as a polyfill, the buggy `require('ink')` succeeds
in the test, the test passes, the model commits and reports
"fixed," and the user's TUI still crashes. The fix is to
treat the binary actually running as the verification gate
— not the unit-test run.

**When this rule does NOT apply**: Pure utility functions,
schemas, type definitions, build/CI scripts, and any code
where the unit-test env is identical to the runtime env.
For these, green tests are sufficient.

**See also**:
- Root `AGENTS.md` "Verification Gate" — the high-level
  principle
- `.factory/skills/verification-before-completion/SKILL.md`
  — the workflow
- `no-require-in-esm` rule (in `typescript.md`) — the static
  check that catches the specific bug class

## Related rules

- `tdd.md` (write the failing test first)
- `nextjs.md` (server components by default — verify with Context7
  before doing anything RSC-related)
- `api.md` (zod-parsed contracts — verify with Context7 before
  writing zod schemas)

## Machine-readable patterns

```yaml
- id: evidence-first-coding
  severity: high
  advisory: true
  prompt_regex:
    - "(?i)\\b(write|add|create|fix|update|implement)\\b.*\\b(function|component|hook|module|script|endpoint|procedure|tool)\\b"
  suggestion: "Before writing code, read the relevant files and call mcp__context7__query-docs for any external library. State the causal chain. See .factory/rules/evidence-first.md."
  citations:
    - "https://docs.factory.ai/guides/power-user/setup-checklist"
- id: verification-is-the-binary-running
  severity: high
  diff_regex: []
  prompt_regex:
    - "(?i)(should|now|must)\\s+work\\b.*\\b(test|tests)\\b.*\\b(pass|green|passing)\\b"
    - "(?i)\\b(unit\\s+tests|tests)\\s+(pass|passed|passing)\\b.*\\b(done|fixed|complete|working|works)\\b"
    - "(?i)\\b(i|we)\\s+(ran|run)\\s+(the\\s+)?(unit\\s+)?tests?\\b.*\\b(should|must|now)\\s+(work|be\\s+(done|fixed|complete))\\b"
  suggestion: |
    "Unit tests pass" is not the verification gate for
    runtime user-facing code. The proof is the binary
    actually running end-to-end with a real TTY and a real
    sign-in / real data, and the user-visible output
    demonstrating the expected state. The recurring
    failure mode (2026-06-15: ReferenceError: require is
    not defined, masked by vitest's CJS polyfill) is the
    canonical case. For TUI/CLI/desktop/dashboard code,
    run the actual binary and assert the rendered output.
    See .factory/rules/evidence-first.md and
    verification-before-completion skill.
  citations:
    - "file:apps/cli/AGENTS.md"
```
