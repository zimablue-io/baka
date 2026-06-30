# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| `0.1.x` | yes |
| `< 0.1` | no |

Baka is at `0.1.0`. Security fixes land on `main` and are released as patch versions of the current minor.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities. Email **security@zimablue.io** with:

- A clear description of the issue and the impact you observed
- A reproducer (steps, code snippet, or proof of concept)
- The affected version(s) and commit SHA(s)
- Your name and how you would like to be credited in the advisory (or "anonymous")

You can expect:

- **Acknowledgement** within 3 business days
- A **status update** within 7 business days, with our initial assessment and a target fix date or a rationale for declining
- **Credit** in the release notes and the GitHub Security Advisory, unless you request otherwise
- A **CVE** coordinated through GitHub Security Advisories when the report warrants one

We follow responsible disclosure. Please give us a reasonable window to investigate and patch before sharing details publicly. We will work with you on the timeline.

## Scope

In scope:

- Code execution, path traversal, or other RCE-class issues in the `baka` CLI, the `baka-mcp` MCP server, the API, or any package in this repo
- Credential or secret leakage in the engine's local config (`~/.baka/`)
- Provider boundary violations: any code outside `packages/agent-engine/` that imports a provider, HTTP client, or model name
- Unsafe handling of module manifests, action templates, or validator inputs

Out of scope:

- Issues in third-party dependencies. Please report them upstream and then link the advisory in an issue here so we can track the upgrade.
- Denial of service from running the engine with a maliciously crafted LLM provider URL. The user opts into the provider, but please still report if you find a way to bypass the warning flow.

## Safe-harbor

We will not pursue legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction, or service disruption
- Only interact with accounts they own or with explicit permission from the owner
- Stop testing immediately if they encounter user data and report it to us
- Do not exploit a vulnerability beyond what is necessary to demonstrate it
- Keep vulnerability details confidential until we have published a fix (or 90 days, whichever comes first)

## Recognition

We maintain a list of reporters in release notes. Thank you for helping keep baka and its users safe.
