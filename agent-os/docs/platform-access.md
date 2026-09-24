# Agent platform access (core-be)

All project agents in [`agent-os/agents/`](../agents/) are **read-only** — they run in
isolation, produce a structured report, and never edit files. To apply findings,
invoke the wrapping skill inline in the main conversation.

## How to invoke on each platform

| Tool | How to invoke |
| ---- | ------------- |
| **Cursor** | `@<agent-name>` in Agent mode; model also auto-invokes from the `description` frontmatter field |
| **Claude Code** | `"Read agent-os/agents/<agent-name>.md and follow the procedure"` |
| **Codex** | Listed in `AGENTS.md` custom subagents table — invoke by name in your prompt |

Replace `<agent-name>` with the agent's `name:` frontmatter value (e.g. `be-dependency-auditor`).

## All agents

See [agents-catalog.md](agents-catalog.md) for the full catalog with
use-when descriptions and the skills each agent wraps.
