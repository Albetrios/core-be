# agent-os/commands — cross-platform custom commands

Reusable, project-scoped slash commands shared by all three AI tools. This
directory is the **single source of truth**; each tool reads it through a symlink
or a one-time setup step (the same pattern as `agent-os/agents` and
`agent-os/skills`).

## How each tool picks them up

| Tool | Path | Wiring | Invoke |
| ---- | ---- | ------ | ------ |
| **Claude Code** | `.claude/commands/` | symlink → `../agent-os/commands` (committed) | `/be-validate`, `/be-new-domain ...` |
| **Cursor** | `.cursor/commands/` | symlink → `../agent-os/commands` (committed) | type `/` in chat (Cursor ≥ 1.6) |
| **Codex** | `~/.codex/prompts/` | user-global — see setup below | `/<name>` in the TUI |

> Cursor ignores the YAML frontmatter and uses the markdown body as the prompt;
> Claude Code and Codex read `description` / `argument-hint` and expand
> `$ARGUMENTS`.

### Codex setup (one-time, per machine)

Codex loads prompts from `~/.codex/prompts/*.md` (user-global, not committable),
and OpenAI now marks custom prompts **deprecated** in favor of skills. To use
these with Codex in the meantime, symlink each file into your prompts dir:

```bash
mkdir -p ~/.codex/prompts
for f in "$PWD"/agent-os/commands/*.md; do ln -sf "$f" ~/.codex/prompts/; done
```

## Commands

Granular procedures live in **skills** (invoked by name); these commands are **workflows** that orchestrate them. Names are collision-checked against skills (`pnpm agent-os:check`).

**Core**

| Command | Purpose |
| ------- | ------- |
| `/be-validate` | Run `pnpm validate` (lint + format + typecheck); fix introduced issues. |
| `/be-ci-local` | Run the full `pnpm ci:local` PR gate; summarize and fix failures. |
| `/be-new-domain <name>` | Scaffold a domain/sub-domain via the be-domain-generator skill (full DAG). |
| `/be-routes-sync` | Re-sync route catalog + OpenAPI/seed artifacts after route changes. |
| `/be-structure-audit` | Monthly semantic drift audit — hand-written docs/skills/rules vs the actual `src/` tree (also run by the `monthly-structure-audit` scheduled routine). |

**Autonomous build**

| Command | Purpose |
| ------- | ------- |
| `/be-build-requirement` | One filled intake → full production-ready slice (schema → API → workers → tests → docs) + reports bundle. |

**Build chains** (from `agent-os/skills/chains.json`)

| Command | Purpose |
| ------- | ------- |
| `/be-route-complete` | Route change end-to-end: contract → schema-docs → catalog → seed (+ openapi, tests). |
| `/be-schema-complete` | Schema change end-to-end: be-schema-generator → sql-design → migration → RLS. |
| `/be-worker-complete` | Events/queues/workers end-to-end: be-workers-events → tests → tsdoc. |

**Review**

| Command | Purpose |
| ------- | ------- |
| `/be-pre-merge-review` | Read-only pipeline (sql-design → rls → idempotency → verifier); one aggregated report. |

**PR lifecycle**

| Command | Purpose |
| ------- | ------- |
| `/be-open-pr [title]` | Push the branch + open a PR to `main` (the explicit PR opt-in). |
| `/be-watch-pr <n>` | Subscribe to a PR; triage CI + review comments until green. |
| `/be-merge-pr <n>` | Merge once CI is green and approvals are in. |
| `/be-ship [title]` | The full flow: open-pr → watch-pr → merge-pr. |

**Maintenance**

| Command | Purpose |
| ------- | ------- |
| `/be-agent-os-sync` | Regenerate adapters from common + run the agent-os gates; fix drift. |

## Related: SessionStart + guardrails

The session-start and guardrail follow-up is implemented — see
[`agent-os/hooks/README.md`](../hooks/README.md):

- **SessionStart** (`agent-os/hooks/session-start.sh`) — on Claude Code on the web,
  verifies Node/deps/codegraph, installs deps, and prints the skill-trigger map.
- **Guardrails** — block destructive shell + secret writes; warn on protected paths
  and cross-domain imports. Claude: `PreToolUse` (`guardrails.mjs`); Cursor:
  `beforeShellExecution` (`cursor-shell-guard.mjs`) + advisory rule; Codex: AGENTS.md
  policy + sandbox/approvals.
