# Codebase Knowledge Management Skill

## Purpose

Document and retrieve project-specific patterns, conventions, and gotchas to avoid re-discovering them each session.

## When to Use

- **Onboarding**: New agents can quickly understand project conventions
- **Gotcha Discovery**: When you encounter a non-obvious pattern or workaround, document it
- **Convention Drift**: When behavior changes, update the relevant knowledge files

## Knowledge Files

| File | Contents |
|------|----------|
| `memory-bank/patterns.md` | Code patterns, architecture decisions |
| `memory-bank/gotchas.md` | Non-obvious behaviors, workarounds |
| `memory-bank/conventions.md` | Style guide, naming, structure |
| `memory-bank/tooling.md` | Build commands, test commands, tooling quirks |

## Workflow

### 1. Document a Discovery

When you discover something non-obvious:

1. Determine which file it belongs in (patterns/gotchas/conventions/tooling)
2. Add entry with date and context
3. Include WHY, not just WHAT

```markdown
### Ray Workers on macOS (2026-05-17)
**Problem**: Tests spawning Ray workers cause "python quit unexpectedly" crashes
**Why**: Ray creates subprocess workers that don't clean up properly on macOS
**Workaround**: Use session-scoped Ray fixture to share cluster across tests
**Avoid**: Don't init/shutdown Ray in individual tests
```

### 2. Retrieve on Session Start

When starting a new task, check relevant knowledge files:

```bash
# Check for relevant patterns before implementing
cat memory-bank/gotchas.md | grep -A5 "Ray\|testing\|macOS"
```

### 3. Update When Patterns Change

If you implement something that contradicts documented patterns, either:
- Update the pattern (you found a better way)
- Document WHY the old pattern is obsolete

## Entry Format

```markdown
### [Title] (YYYY-MM-DD)

**Category**: [testing|ray|auth|api|db|frontend|python|tooling]
**Context**: [When does this apply]
**Pattern**: [What to do]
**Why**: [Explain the reasoning]
**Related**: [Links to code, docs, or other patterns]
```

## Automated Documentation

After completing a task, check if any new patterns emerged:

1. Did you encounter any non-obvious behavior?
2. Did you discover a better approach than documented?
3. Did any command behave differently than expected?

If yes to any, document it before finishing.

## Integration with Droids

Each specialist droid should maintain their domain knowledge:

| Droid | Knowledge Area |
|-------|----------------|
| `python-dev` | Python package patterns, uv usage, async patterns |
| `api-dev` | TypeScript API patterns, middleware conventions |
| `frontend-dev` | React/Next.js patterns, component structure |
| `tester` | Test patterns, E2E flows, debugging strategies |
| `rl-dev` | RL training patterns, Ray quirks, environment setup |

## Example Session

```bash
# Before starting a Python testing task
cat memory-bank/gotchas.md

# Output:
# ### Ray Workers on macOS (2026-05-17)
# **Pattern**: Use session-scoped Ray fixture
# **Avoid**: Don't init/shutdown Ray in individual tests
```

## Skill Trigger

Invoke this skill when:
- Starting a new task area
- Encountering unexpected behavior
- Completing a task with non-obvious learnings
- Reading AGENTS.md files
