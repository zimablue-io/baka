# TDD Rules

**Owner**: Platform Team
**Last Updated**: 2026-06-11
**Applies to**: All code changes in this monorepo.

> TDD is mandatory per the root `AGENTS.md`. This file is a
> scannable form of the operating contract.

## The Cycle

**Applies to**: Every code change.

**Rule**: Follow the Red → Verify Red → Green → Verify Green →
Refactor cycle. Watch every test fail before writing the code.

### 1. RED — Write a failing test

Write one minimal test that describes the behavior you want. The
test must:

- Be small and clearly named.
- Test behavior, not implementation.
- Use real code, not mocks, unless the boundary genuinely requires
  a mock (network, time, randomness).

### 2. Verify RED

Run the test. Confirm:

- The test **fails**, not errors.
- The failure is the expected one ("feature missing"), not a typo
  or import error.

If the test passes, you are testing existing behavior. Fix the
test. If the test errors, fix the error, re-run, and re-confirm
the failure is the right one.

### 3. GREEN — Write the minimal code

Write the smallest amount of code that makes the test pass. Do
not add features, do not refactor adjacent code, do not "improve"
the API while you are in the test.

### 4. Verify GREEN

Run the test. Confirm:

- It passes.
- Other tests still pass.
- The output is pristine (no errors, no warnings).

### 5. REFACTOR

Clean up. Rename, extract, deduplicate. Keep tests green.

## Common rationalizations to reject

- "Tests after achieve the same goal." — They don't. Tests-after
  prove the code does what you wrote; tests-first prove the code
  does what is required.
- "I'll manually test all the edge cases." — Manual testing has
  no record, can't be re-run, forgets cases under pressure.
- "It's a prototype." — Prototypes become production.
- "TDD will slow me down." — TDD is faster than debugging.
- "Deleting hours of work is wasteful." — Sunk cost. Keeping
  unverified code is technical debt.

## When TDD Is Not the Right Tool

**Applies to**: A narrow set of cases.

**Rule**: TDD is mandatory except for:

- **Generated code** that is mechanically produced from a schema
  or a generator.
- **Configuration files** (this rule file is a configuration).
- **Throwaway experiments** that you commit to deleting.

Everything else: TDD. Always.

## Related rules

- Root `AGENTS.md` "TDD Is Mandatory"
- `testing.md` (test quality, mock at the boundary, no skipped tests)
- `evidence-first.md` (gather evidence before writing the test)

## Machine-readable patterns

```yaml
- id: tdd-mandatory
  severity: high
  advisory: true
  diff_regex: []
  prompt_regex:
    - "(?i)\\b(skip|skipping|without)\\s+(the\\s+)?test(s)?\\b"
    - "(?i)\\b(write|add|implement)\\b.*\\bproduction\\s+code\\b"
  suggestion: "TDD is mandatory. Write the failing test first; verify it fails for the right reason; write the minimal code; verify green. See .factory/rules/tdd.md."
  citations:
    - "https://en.wikipedia.org/wiki/Test-driven_development"
```
