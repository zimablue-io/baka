# sdd — Spec-Driven Development

Generates the project constitution and per-feature spec folders using LLM reasoning over handlebars prompts.

## Actions

- **init-constitution** — Create `specs/mission.md`, `specs/tech-stack.md`, `specs/roadmap.md` at the project root.
- **create-feature** — Create `specs/YYYY-MM-DD-<name>/{plan.md, requirements.md, validation.md}`.

## Usage

```bash
# Initialize the constitution
baka plan "initialize constitution for MyApp, a fitness tracker"

# Create a feature spec
baka plan "create feature spec for user-authentication"
```

Each action takes handlebars templates from `templates/*.hbs`, pre-renders them with the action's params, and calls the LLM to generate the actual content. Generated content is written to the appropriate location in `specs/`.

## Shape

```
specs/
├── mission.md           ← why we are building
├── tech-stack.md        ← core technical decisions
├── roadmap.md           ← phased plan
└── YYYY-MM-DD-<name>/   ← per-feature folder
    ├── plan.md          ← numbered task groups
    ├── requirements.md  ← scope, key decisions, context
    └── validation.md    ← success criteria
```
