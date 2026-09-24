# Cross-Platform AI Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all AI agent configuration into a single `agent-os/` directory at the repo root. Every subdirectory has one responsibility — no loose files at `agent-os/` root. All three tools symlink into `agent-os/` so each reads from the same canonical source.

**Architecture:** `agent-os/` is the single source of truth, fully directory-structured. `.cursor/`, `.claude/`, and `.codex/` each get symlinks pointing into the appropriate `agent-os/` subdirectory. Cursor and Claude Code both natively support `agents/`, `skills/`, and `hooks/` — those three symlinks serve both tools at once. Codex reads `AGENTS.md` + `AGENTS.override.md` at repo root, both of which point into `agent-os/`.

**Platforms:** Cursor · Claude Code · Codex (OpenAI CLI)

**Tech Stack:** Markdown files, bash hook scripts, JSON settings, POSIX symlinks (macOS/Linux).

---

## Final directory layout

```text
agent-os/
  agents/              ← moved from .cursor/agents/         (8 agent .md files)
  skills/              ← moved from .cursor/skills/         (36 skill dirs)
  rules/               ← moved from .cursor/rules/          (42 .mdc files)
  hooks/
    skill-reminder.sh  ← NEW: Claude Code PostToolUse reminder
  mcp/
    mcp.example.json   ← moved from .cursor/mcp.example.json (tracked template)
    mcp.json           ← gitignored, machine-specific (copy from example)
  docs/
    platform-access.md ← NEW: how to invoke agents on Cursor, Claude Code, Codex
    agents-catalog.md  ← NEW: all 8 agents with use-when descriptions
    principles.md      ← NEW: engineering principles + project identity
    skill-triggers.md  ← NEW: file pattern → skill trigger map

── Symlinks ──────────────────────────────────────────────────────────────

.cursor/
  agents           →  ../agent-os/agents               (Cursor reads agents)
  skills           →  ../agent-os/skills               (Cursor reads skills)
  rules            →  ../agent-os/rules                (Cursor reads rules)
  mcp.json         →  ../agent-os/mcp/mcp.json          (gitignored)
  mcp.example.json →  ../agent-os/mcp/mcp.example.json  (tracked template)

.claude/
  agents           →  ../agent-os/agents               (Claude Code reads agents natively here)
  skills           →  ../agent-os/skills               (Claude Code reads skills natively here)
  hooks            →  ../agent-os/hooks                (Claude Code hook scripts)

.mcp.json          →  agent-os/mcp/mcp.json            (Claude Code reads MCP config from root)

── Root entry-point files (not symlinked — own content) ─────────────────

CLAUDE.md              Claude Code primary entry point
AGENTS.md              Codex + Claude Code secondary entry point
```

`agent-os/agents/` and `agent-os/skills/` are shared by three symlinks each (`.cursor/`, `.claude/`, and `agent-os/` itself). One canonical location, zero duplication.

---

## File map

| Action | File | Responsibility |
|--------|------|----------------|
| **Move — core dirs** | | |
| Move | `.cursor/agents/` → `agent-os/agents/` | 8 agent files; canonical location for all tools |
| Move | `.cursor/skills/` → `agent-os/skills/` | 36 skill dirs; canonical location for all tools |
| Move | `.cursor/rules/` → `agent-os/rules/` | 42 rule files; Cursor-specific format |
| Move | `.cursor/mcp.example.json` → `agent-os/mcp/mcp.example.json` | Tracked MCP template |
| **Create — new files** | | |
| Create | `agent-os/hooks/skill-reminder.sh` | Claude Code PostToolUse reminder script |
| Create | `agent-os/mcp/mcp.json` | Gitignored machine-specific MCP config |
| Create | `agent-os/docs/platform-access.md` | How to invoke agents on Cursor, Claude Code, Codex |
| Create | `agent-os/docs/agents-catalog.md` | All 8 agents: description, wraps-skill, use-when |
| Create | `agent-os/docs/principles.md` | Engineering principles + project identity (cross-platform source) |
| Create | `agent-os/docs/skill-triggers.md` | File pattern → skill trigger map |
| **Symlinks — .cursor/** | | |
| Create symlink | `.cursor/agents → ../agent-os/agents` | Cursor reads agents |
| Create symlink | `.cursor/skills → ../agent-os/skills` | Cursor reads skills |
| Create symlink | `.cursor/rules → ../agent-os/rules` | Cursor reads rules |
| Create symlink | `.cursor/mcp.json → ../agent-os/mcp/mcp.json` | Cursor reads live MCP config |
| Create symlink | `.cursor/mcp.example.json → ../agent-os/mcp/mcp.example.json` | Cursor reads MCP template |
| **Symlinks — .claude/** | | |
| Create symlink | `.claude/agents → ../agent-os/agents` | Claude Code reads agents natively |
| Create symlink | `.claude/skills → ../agent-os/skills` | Claude Code reads skills natively |
| Create symlink | `.claude/hooks → ../agent-os/hooks` | Claude Code hook scripts |
| **Symlinks — repo root** | | |
| Create symlink | `.mcp.json → agent-os/mcp/mcp.json` | Claude Code reads MCP from root |
| **Modify — existing files** | | |
| Modify | `.gitignore` | Add `agent-os/mcp/mcp.json` |
| Modify | `.claude/settings.json` | Add PostToolUse + Stop hooks; add tool allowlist |
| Modify | All 8 `agent-os/agents/*.md` | Replace inline platform table with `agent-os/docs/platform-access.md` ref |
| Modify | `agent-os/skills/` internal refs | Rewrite `.cursor/` paths → `agent-os/` paths |
| Modify | `agent-os/rules/` internal refs | Rewrite `.cursor/` paths → `agent-os/` paths |
| Modify | `agent-os/rules/be-engineering-principles.mdc` | Add "Source: agent-os/docs/principles.md" note |
| Modify | `agent-os/rules/be-project-identity.mdc` | Add "Source: agent-os/docs/principles.md" note |
| Modify | `CLAUDE.md` | Add `## AI tooling (agent-os/)` section |
| Modify | `AGENTS.md` | Replace agents table; add `agent-os/` references |
| Modify | `docs/integrations/cursor-agent-system.md` | Update all paths to `agent-os/` |

---

## Task 1: Move agents, skills, rules to agent-os/ and create symlinks

**Files:**

- Move: `.cursor/agents/` → `agent-os/agents/`
- Move: `.cursor/skills/` → `agent-os/skills/`
- Move: `.cursor/rules/` → `agent-os/rules/`
- Create: `.cursor/agents` symlink
- Create: `.cursor/skills` symlink
- Create: `.cursor/rules` symlink

- [ ] **Step 1: Move the three directories**

```bash
mkdir -p ai
git mv .cursor/agents agent-os/agents
git mv .cursor/skills agent-os/skills
git mv .cursor/rules agent-os/rules
```

- [ ] **Step 2: Create .cursor/ symlinks**

```bash
ln -s ../agent-os/agents .cursor/agents
ln -s ../agent-os/skills .cursor/skills
ln -s ../agent-os/rules .cursor/rules
git add .cursor/agents .cursor/skills .cursor/rules
```

- [ ] **Step 3: Create .claude/ symlinks (Claude Code reads agents and skills natively here)**

```bash
ln -s ../agent-os/agents .claude/agents
ln -s ../agent-os/skills .claude/skills
git add .claude/agents .claude/skills
```

- [ ] **Step 4: Verify both tools resolve the paths**

```bash
ls -la .cursor/agents   # → ../agent-os/agents
ls -la .cursor/skills   # → ../agent-os/skills
ls -la .cursor/rules    # → ../agent-os/rules
ls -la .claude/agents   # → ../agent-os/agents
ls -la .claude/skills   # → ../agent-os/skills
ls agent-os/agents/           # 8 .md files
ls agent-os/skills/           # 36 directories
ls agent-os/rules/            # 42 .mdc files
```

- [ ] **Step 5: Commit**

```bash
git add agent-os/
git commit -m "chore(ai): move agents/skills/rules to agent-os/ with .cursor/ and .claude/ symlinks"
```

---

## Task 2: Create agent-os/hooks/skill-reminder.sh

**Files:**

- Create: `agent-os/hooks/skill-reminder.sh`

- [ ] **Step 1: Create the directory and hook script**

```bash
mkdir -p agent-os/hooks
```

File content for `agent-os/hooks/skill-reminder.sh`:

```bash
#!/usr/bin/env bash
# Claude Code PostToolUse hook.
# Reads Edit/Write tool JSON from stdin, extracts the edited file path,
# prints relevant skill reminders based on file pattern matching.

INPUT=$(cat)
FILE=$(echo "$INPUT" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" \
  2>/dev/null || echo "")

[[ -z "$FILE" ]] && exit 0

REMINDERS=()

[[ "$FILE" == *".routes.ts" ]] && \
  REMINDERS+=("routes → be-route-schema-doc-guard + be-route-catalog + be-seed-maintainer")

[[ "$FILE" == *".schema.ts" ]] && \
  REMINDERS+=("schema → be-sql-design-guard + be-db-migration-maintainer")

[[ "$FILE" == *"env-schema.ts"* || "$FILE" == *".env.example"* ]] && \
  REMINDERS+=("env → be-env-schema-add")

[[ "$FILE" == *"/locales/"*".json" ]] && \
  REMINDERS+=("i18n → be-i18n-message-guard")

[[ "$FILE" == *".validator.ts" || "$FILE" == *".serializer.ts" ]] && \
  REMINDERS+=("validator/serializer → be-test-generator")

[[ "$FILE" == *"/events/"*".ts" || "$FILE" == *"/workers/"*".ts" || \
   "$FILE" == *"/queues/"*".ts" ]] && \
  REMINDERS+=("events/workers/queues → be-workers-events skill")

[[ "$FILE" == *".container.ts" ]] && \
  REMINDERS+=("container → be-domain-generator (check DI wiring)")

if [[ "${#REMINDERS[@]}" -gt 0 ]]; then
  echo ""
  echo "⚡ Skill reminders for $(basename "$FILE"):"
  for r in "${REMINDERS[@]}"; do
    echo "  • $r"
  done
  echo "  Full map: agent-os/docs/skill-triggers.md"
fi

exit 0
```

- [ ] **Step 2: Make executable**

```bash
chmod +x agent-os/hooks/skill-reminder.sh
```

- [ ] **Step 3: Test manually**

```bash
echo '{"tool_name":"Edit","tool_input":{"file_path":"/Users/nikunjmavani/projects/core/core-be/src/domains/tenancy/sub-domains/organization/organization.routes.ts"}}' \
  | bash agent-os/hooks/skill-reminder.sh
```

Expected:

```text
⚡ Skill reminders for organization.routes.ts:
  • routes → be-route-schema-doc-guard + be-route-catalog + be-seed-maintainer
  Full map: agent-os/docs/skill-triggers.md
```

- [ ] **Step 4: Create .claude/hooks symlink**

```bash
ln -s ../agent-os/hooks .claude/hooks
git add .claude/hooks
```

- [ ] **Step 5: Commit**

```bash
git add agent-os/hooks/skill-reminder.sh
git commit -m "chore(ai): add skill-reminder hook; symlink .claude/hooks → agent-os/hooks"
```

---

## Task 3: Create agent-os/docs/ reference files

**Files:**

- Create: `agent-os/docs/platform-access.md`
- Create: `agent-os/docs/agents-catalog.md`
- Create: `agent-os/docs/principles.md`
- Create: `agent-os/docs/skill-triggers.md`

- [ ] **Step 1: Create agent-os/docs/platform-access.md**

```markdown
# Agent platform access (core-be)

All project agents in [`agent-os/agents/`](agents/) are **read-only** — they run in
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
```

- [ ] **Step 2: Create agent-os/docs/agents-catalog.md**

```markdown
# Agent catalog (core-be)

All 8 project agents. Each is read-only and wraps a project skill.
See [platform-access.md](platform-access.md) for how to invoke on each platform.

| Agent | File | Wraps skill | Use when |
| ----- | ---- | ----------- | -------- |
| **be-production-reviewer** | [`agent-os/agents/be-production-reviewer.md`](agents/be-production-reviewer.md) | be-path-to-production-gate + be-production-hardening-guard | Pre-release / deploy sign-off — full readiness plan |
| **be-verifier** | [`agent-os/agents/be-verifier.md`](agents/be-verifier.md) | *(inline)* | After claiming work complete — scoped validate/tests + wiring check |
| **be-ci-investigator** | [`agent-os/agents/be-ci-investigator.md`](agents/be-ci-investigator.md) | be-ci-investigator | One failing CI job — root-cause summary without log noise |
| **be-production-hardening-reviewer** | [`agent-os/agents/be-production-hardening-reviewer.md`](agents/be-production-hardening-reviewer.md) | be-production-hardening-guard | Targeted hardening sweep — security headers, DB/Redis/worker gaps |
| **be-docs-auditor** | [`agent-os/agents/be-docs-auditor.md`](agents/be-docs-auditor.md) | be-docs-audit | Full docs/ audit — stale links, index gaps, Mermaid issues |
| **be-sql-design-reviewer** | [`agent-os/agents/be-sql-design-reviewer.md`](agents/be-sql-design-reviewer.md) | be-sql-design-guard | Schema design review — indexes, constraints, column conventions |
| **be-dependency-auditor** | [`agent-os/agents/be-dependency-auditor.md`](agents/be-dependency-auditor.md) | be-dependency-security | `pnpm audit` — vulnerabilities + prioritized fix plan |
| **be-tsdoc-coverage-reviewer** | [`agent-os/agents/be-tsdoc-coverage-reviewer.md`](agents/be-tsdoc-coverage-reviewer.md) | be-tsdoc-export-guard *(check phase)* | TSDoc gap scan — missing summaries and @remarks |
```

- [ ] **Step 3: Create agent-os/docs/principles.md**

Merge the body of `agent-os/rules/be-engineering-principles.mdc` and
`agent-os/rules/be-project-identity.mdc` (strip frontmatter from both) and
prepend this header:

```markdown
# Engineering principles and project identity (core-be)

> **Canonical source** for Claude Code and Codex. Cursor auto-injects
> `agent-os/rules/be-engineering-principles.mdc` and `agent-os/rules/be-project-identity.mdc`
> via `alwaysApply: true`. When you update this file, mirror the changes
> to those two rule files so Cursor stays in sync.

---
```

Then paste the full body of `be-engineering-principles.mdc`, a `---` separator, then
the full body of `be-project-identity.mdc`.

- [ ] **Step 4: Create agent-os/docs/skill-triggers.md**

```markdown
# Skill triggers (core-be)

When you edit a file matching a pattern below, invoke the listed skill(s).
Single source of truth — consult instead of reading all 22 sync rules.
Skills live in [`agent-os/skills/`](skills/).

| File pattern | Invoke skill(s) | Notes |
| ------------ | --------------- | ----- |
| `src/domains/**/*.routes.ts` | be-route-schema-doc-guard → be-route-catalog → be-seed-maintainer | Also be-openapi-multilingual if tags changed |
| `src/domains/**/*.schema.ts` | be-sql-design-guard → be-db-migration-maintainer | |
| `src/domains/**/*.container.ts`, `src/routes.ts` | be-domain-generator (check wiring) | |
| `migrations/*.sql` | be-db-migration-maintainer | |
| `src/shared/config/env-schema.ts`, `.env.example` | be-env-schema-add | |
| `src/shared/locales/**/*.json` | be-i18n-message-guard | |
| `src/domains/**/*.validator.ts`, `*.serializer.ts` | be-test-generator | |
| `src/domains/**/events/**`, `**/workers/**`, `**/queues/**` | be-workers-events | |
| `src/domains/**/seed/**`, `src/scripts/seed/**` | be-seed-maintainer | |
| `src/**/*.ts` (public export added/renamed) | be-tsdoc-export-guard | |
| `docs/**/*.md` | be-docs-maintainer | |
| `src/**/OVERVIEW.md` | be-overview-doc-maintainer | |
| `src/OVERVIEW.md`, `src/PATTERNS.md`, `src/FLOWS.md`, `src/POLICIES.md` | be-system-narrative-maintainer | |
| `biome.json`, `.husky/pre-commit` | be-code-quality-guard | |
| `package.json`, `pnpm-lock.yaml` | be-dependency-security | |
| `src/tests/chaos/**` | be-chaos-test-maintainer | |
| `src/tests/contract/**` | be-contract-test-maintainer | |
| `.vscode/extensions.json`, `.vscode/settings.json` | be-ide-productivity-guard | |
| `tooling/setup/**`, `setup.config.json` | setup-infra-maintainer | |
| `src/shared/locales/*/openapi.json` | be-openapi-multilingual | |
| `CLAUDE.md`, `AGENTS.md`, `agent-os/rules/**`, `agent-os/skills/**`, `agent-os/agents/**` | be-structure-maintainer | |
| `tooling/setup/setup.config.json`, `src/shared/constants/project-identity.constants.ts` | be-project-identity-sync | |

> The 22 `agent-os/rules/*-sync.mdc` files remain for Cursor's glob auto-attach.
> This table is the human-readable cross-platform equivalent.
```

- [ ] **Step 5: Commit**

```bash
git add agent-os/docs/
git commit -m "docs(ai): add agent-os/docs/ reference files"
```

---

## Task 4: Update all 8 agent files — replace inline platform table

**Files:**

- Modify: all 8 files in `agent-os/agents/`

- [ ] **Step 1: In each of the 5 new agents, replace the inline Platform access section**

For `production-hardening-reviewer.md`, `docs-auditor.md`, `sql-design-reviewer.md`,
`dependency-auditor.md`, `tsdoc-coverage-reviewer.md` — find:

```markdown
## Platform access

| Tool | How to invoke |
| ---- | ------------- |
| **Cursor** | `@<agent-name>` in Agent mode, or model auto-invokes from description |
| **Claude Code** | "Read `.cursor/agents/<agent-name>.md` and follow the procedure" |
| **Codex** | Listed in `AGENTS.md` custom subagents table — Codex reads it as a named agent |
```

Replace with:

```markdown
## Platform access

See [agent-os/docs/platform-access.md](../platform-access.md) — covers Cursor, Claude Code,
and Codex invocation. This agent's `<agent-name>` is the `name:` value in the
frontmatter above.
```

- [ ] **Step 2: Add Platform access section to the 3 original agents that lack it**

For `be-ci-investigator.md`, `verifier.md`, `production-reviewer.md` — append at the end:

```markdown
## Platform access

See [agent-os/docs/platform-access.md](../platform-access.md) — covers Cursor, Claude Code,
and Codex invocation. This agent's `<agent-name>` is the `name:` value in the
frontmatter above.
```

- [ ] **Step 3: Update skill path references inside agent files**

Inside each agent file, any path of the form `.cursor/skills/X/SKILL.md` must
become `agent-os/skills/X/SKILL.md`. Run:

```bash
grep -rl "\.cursor/skills/" agent-os/agents/ | xargs sed -i '' 's|\.cursor/skills/|agent-os/skills/|g'
```

Verify:

```bash
grep -r "\.cursor/skills/" agent-os/agents/
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add agent-os/agents/
git commit -m "chore(agents): update skill paths to agent-os/ and add platform-access reference"
```

---

## Task 5: Update skill files — internal cross-references

**Files:**

- Modify: skill files in `agent-os/skills/` that reference `.cursor/` paths

- [ ] **Step 1: Rewrite all .cursor/ path references inside skill files**

```bash
grep -rl "\.cursor/skills/" agent-os/skills/ | xargs sed -i '' 's|\.cursor/skills/|agent-os/skills/|g'
grep -rl "\.cursor/agents/" agent-os/skills/ | xargs sed -i '' 's|\.cursor/agents/|agent-os/agents/|g'
grep -rl "\.cursor/rules/"  agent-os/skills/ | xargs sed -i '' 's|\.cursor/rules/|agent-os/rules/|g'
```

- [ ] **Step 2: Verify no stale .cursor/ references remain in agent-os/skills/**

```bash
grep -r "\.cursor/skills/\|\.cursor/agents/\|\.cursor/rules/" agent-os/skills/
```

Expected: no output.

- [ ] **Step 3: Check one skill file to confirm paths look correct**

```bash
head -20 agent-os/skills/be-skill-index/SKILL.md
```

Expected: skill table paths show `agent-os/skills/X/SKILL.md`, not `.cursor/skills/X/SKILL.md`.

- [ ] **Step 4: Commit**

```bash
git add agent-os/skills/
git commit -m "chore(skills): update internal cross-references to agent-os/ paths"
```

---

## Task 6: Update ruleset files — internal references

**Files:**

- Modify: rule files in `agent-os/rules/` that reference `.cursor/` paths

- [ ] **Step 1: Rewrite .cursor/ path references inside ruleset files**

```bash
grep -rl "\.cursor/skills/" agent-os/rules/ | xargs sed -i '' 's|\.cursor/skills/|agent-os/skills/|g'
grep -rl "\.cursor/agents/" agent-os/rules/ | xargs sed -i '' 's|\.cursor/agents/|agent-os/agents/|g'
grep -rl "\.cursor/rules/"  agent-os/rules/ | xargs sed -i '' 's|\.cursor/rules/|agent-os/rules/|g'
```

- [ ] **Step 2: Add source pointer to the two alwaysApply rules**

In `agent-os/rules/be-engineering-principles.mdc`, after the frontmatter, add:

```markdown
> **Source:** [`agent-os/docs/principles.md`](../../agent-os/docs/principles.md) — edit there for Claude Code / Codex; mirror changes here for Cursor auto-inject.
```

In `agent-os/rules/be-project-identity.mdc`, after the frontmatter, add:

```markdown
> **Source:** [`agent-os/docs/principles.md`](../../agent-os/docs/principles.md) — edit there for Claude Code / Codex; mirror changes here for Cursor auto-inject.
```

- [ ] **Step 3: Verify**

```bash
grep -r "\.cursor/skills/\|\.cursor/agents/\|\.cursor/rules/" agent-os/rules/
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add agent-os/rules/
git commit -m "chore(rules): update internal paths to agent-os/ and add principles source pointer"
```

---

## Task 7: Update .claude/settings.json

**Files:**

- Modify: `.claude/settings.json`

- [ ] **Step 1: Replace the file content**

```json
{
  "permissions": {
    "allow": [
      "mcp__codegraph__codegraph_search",
      "mcp__codegraph__codegraph_context",
      "mcp__codegraph__codegraph_callers",
      "mcp__codegraph__codegraph_callees",
      "mcp__codegraph__codegraph_impact",
      "mcp__codegraph__codegraph_node",
      "mcp__codegraph__codegraph_status",
      "Bash(pnpm validate*)",
      "Bash(pnpm test*)",
      "Bash(pnpm lint*)",
      "Bash(pnpm typecheck*)",
      "Bash(pnpm routes*)",
      "Bash(pnpm docs*)",
      "Bash(pnpm tsdoc*)",
      "Bash(pnpm guard*)",
      "Bash(git status)",
      "Bash(git diff*)",
      "Bash(git log*)",
      "Bash(git branch*)",
      "Bash(gh pr*)"
    ]
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "bash /Users/nikunjmavani/projects/core/core-be/agent-os/hooks/skill-reminder.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo '\n📋 Done. Quick checks: pnpm validate:domain --strict && pnpm tsdoc:check\n   Skill map: agent-os/docs/skill-triggers.md'"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add .claude/settings.json
git commit -m "chore(claude): add PostToolUse + Stop hooks and tool allowlist"
```

---

## Task 8: Update CLAUDE.md

**Files:**

- Modify: `CLAUDE.md`

- [ ] **Step 1: Add AI agent references section**

After the "New requirements — intake format" section, insert:

```markdown
## AI agent references (`agent-os/`)

`agent-os/` at the repo root is the single source of truth for all AI tooling.
Cursor reads agents/skills/rules via symlinks (`.cursor/agents → agent-os/agents`, etc.).
Claude Code and Codex reference `agent-os/` directly.

| File | Purpose |
| ---- | ------- |
| [`agent-os/docs/principles.md`](agent-os/docs/principles.md) | Engineering principles + project identity (full detail) |
| [`agent-os/docs/skill-triggers.md`](agent-os/docs/skill-triggers.md) | File pattern → skill map (replaces reading 22 sync rules) |
| [`agent-os/docs/agents-catalog.md`](agent-os/docs/agents-catalog.md) | All 8 agents with descriptions and use-when |
| [`agent-os/docs/platform-access.md`](agent-os/docs/platform-access.md) | How to invoke agents on Cursor, Claude Code, Codex |
| [`agent-os/agents/`](agent-os/agents/) | Agent definition files |
| [`agent-os/skills/`](agent-os/skills/) | Skill definition files |
| [`agent-os/rules/`](agent-os/rules/) | Cursor rule files (also accessible via `.cursor/rules/` symlink) |
| [`agent-os/hooks/`](agent-os/hooks/) | Claude Code hook scripts |
```markdown

- [ ] **Step 2: Update the existing be-skill-index reference**

Find:

```markdown
Consult **`.cursor/skills/be-skill-index/SKILL.md`**
```

Replace with:

```markdown
Consult **`agent-os/skills/be-skill-index/SKILL.md`**
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): add agent-os/ reference table and update be-skill-index path"
```

---

## Task 9: Update AGENTS.md

**Files:**

- Modify: `AGENTS.md`

- [ ] **Step 1: Update the be-skill-index reference**

Find:

```markdown
consult **[be-skill-index](.cursor/skills/be-skill-index/SKILL.md)**
```

Replace with:

```markdown
consult **[be-skill-index](agent-os/skills/be-skill-index/SKILL.md)**
```

- [ ] **Step 2: Replace the custom subagents table**

Replace:

```markdown
## Custom subagents

Project-defined subagents in [`.cursor/agents/`](.cursor/agents/) run in isolation ...

| Subagent | File | Use when |
| -------- | ---- | -------- |
[8 rows]

To add a subagent, use global **create-subagent** ...
```

With:

```markdown
## Custom subagents

Project-defined subagents in [`agent-os/agents/`](agent-os/agents/) run in isolation
(read-only) for heavy diagnostics.

**Full catalog + use-when:** [agent-os/docs/agents-catalog.md](agent-os/docs/agents-catalog.md)
**Platform invocation (Cursor / Claude Code / Codex):** [agent-os/docs/platform-access.md](agent-os/docs/platform-access.md)
**Skill trigger map:** [agent-os/docs/skill-triggers.md](agent-os/docs/skill-triggers.md) — file pattern → which skill to invoke.

To add a subagent, use global **create-subagent**
(see [be-cursor-global-skills](agent-os/skills/be-cursor-global-skills/SKILL.md)).
```

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs(agents): update all .cursor/ paths to agent-os/ canonical paths"
```

---

## Task 10: Update cursor-agent-system.md

**Files:**

- Modify: `docs/integrations/cursor-agent-system.md`

- [ ] **Step 1: Update all .cursor/ path references**

```bash
sed -i '' \
  -e 's|\(\.cursor/skills/\)|agent-os/skills/|g' \
  -e 's|\(\.cursor/agents/\)|agent-os/agents/|g' \
  -e 's|\(\.cursor/rules/\)|agent-os/rules/|g' \
  docs/integrations/cursor-agent-system.md
```

- [ ] **Step 2: Replace the custom subagents section**

Replace the current "## Custom subagents" section with:

```markdown
## Custom subagents

Defined in [`agent-os/agents/`](../../agent-os/agents/). All agents are **read-only**.
Cursor reads them via `.cursor/agents` → `agent-os/agents/` symlink.

| Reference | Link |
| --------- | ---- |
| Full catalog + use-when | [agent-os/docs/agents-catalog.md](../../agent-os/docs/agents-catalog.md) |
| Platform invocation table | [agent-os/docs/platform-access.md](../../agent-os/docs/platform-access.md) |

| Tool | How agents are invoked |
| ---- | ---------------------- |
| **Cursor** | `@<agent-name>` in Agent mode; auto-invokes from `description` frontmatter |
| **Claude Code** | `"Read agent-os/agents/<name>.md and follow the procedure"` |
| **Codex** | Reads `AGENTS.md` custom subagents table; invoke by name |

Add new agents with global **create-subagent**. See [be-cursor-global-skills](../../agent-os/skills/be-cursor-global-skills/SKILL.md).
```

- [ ] **Step 3: Commit**

```bash
git add docs/integrations/cursor-agent-system.md
git commit -m "docs(integrations): update all paths to canonical agent-os/ directory"
```

---

## Task 11: Migrate MCP config to agent-os/mcp/

**Files:**

- Move: `.cursor/mcp.example.json` → `agent-os/mcp/mcp.example.json`
- Create: `agent-os/mcp/mcp.json` (gitignored)
- Create: `.cursor/mcp.example.json` symlink
- Create: `.cursor/mcp.json` symlink
- Create: `.mcp.json` symlink (repo root)
- Modify: `.gitignore`
- Modify: `docs/integrations/cursor-agent-system.md`

- [ ] **Step 1: Move the example file and create agent-os/mcp/**

```bash
mkdir -p agent-os/mcp
git mv .cursor/mcp.example.json agent-os/mcp/mcp.example.json
```

- [ ] **Step 2: Copy example to live config (gitignored)**

```bash
cp agent-os/mcp/mcp.example.json agent-os/mcp/mcp.json
```

Users configure `agent-os/mcp/mcp.json` once. All three platforms read from it via symlinks.

- [ ] **Step 3: Create the three symlinks**

```bash
# Cursor reads template and live config from .cursor/
ln -s ../agent-os/mcp/mcp.example.json .cursor/mcp.example.json
ln -s ../agent-os/mcp/mcp.json .cursor/mcp.json

# Claude Code reads live config from repo root
ln -s agent-os/mcp/mcp.json .mcp.json

git add .cursor/mcp.example.json .cursor/mcp.json .mcp.json
```gitignore

- [ ] **Step 4: Add agent-os/mcp/mcp.json to .gitignore**

In `.gitignore`, find the existing MCP entries:

```

.cursor/mcp.json
.mcp.json

```text

Add below them:

```

agent-os/mcp/mcp.json

```markdown

- [ ] **Step 5: Verify symlinks resolve correctly**

```bash
ls -la .cursor/mcp.example.json  # → ../agent-os/mcp/mcp.example.json
ls -la .cursor/mcp.json          # → ../agent-os/mcp/mcp.json
ls -la .mcp.json                 # → agent-os/mcp/mcp.json
cat .cursor/mcp.json | head -5   # should print the JSON content
```

- [ ] **Step 6: Update cursor-agent-system.md MCP section**

Find:

```markdown
Template: [`.cursor/mcp.example.json`](../../.cursor/mcp.example.json) → copy to `.cursor/mcp.json` (gitignored).
```

Replace with:

```markdown
Template: [`agent-os/mcp/mcp.example.json`](../../agent-os/mcp/mcp.example.json) → copy to `agent-os/mcp/mcp.json` (gitignored).
Symlinked: `.cursor/mcp.json` → `agent-os/mcp/mcp.json` (Cursor), `.mcp.json` → `agent-os/mcp/mcp.json` (Claude Code).
Configure once — all three platforms read the same file.
```

- [ ] **Step 7: Commit**

```bash
git add agent-os/mcp/ .gitignore docs/integrations/cursor-agent-system.md
git commit -m "chore(ai): centralize MCP config in agent-os/mcp/ with symlinks for Cursor and Claude Code"
```

---

## Final: Full pre-commit gate

- [ ] **Step 1: Run pre-commit gate**

```bash
pnpm guard:pre-commit
```

Expected: all 19 steps green.

- [ ] **Step 2: Verify all symlinks are tracked by git**

```bash
git ls-files .cursor/agents .cursor/skills .cursor/rules \
             .claude/agents .claude/skills .claude/hooks \
             .codex/config.toml AGENTS.override.md
```

Expected: all 8 entries listed (symlinks are tracked as files).

- [ ] **Step 3: Verify both Cursor and Claude Code resolve agents via symlink**

```bash
ls .cursor/agents/   # 8 .md files
ls .claude/agents/   # same 8 .md files (same symlink target)
ls .claude/skills/be-skill-index/  # SKILL.md
```

- [ ] **Step 4: Verify hook fires correctly**

```bash
echo '{"tool_name":"Edit","tool_input":{"file_path":"/Users/nikunjmavani/projects/core/core-be/src/domains/auth/sub-domains/auth-method/auth-method.schema.ts"}}' \
  | bash agent-os/hooks/skill-reminder.sh
```

Expected:

```text
⚡ Skill reminders for auth-method.schema.ts:
  • schema → be-sql-design-guard + be-db-migration-maintainer
  Full map: agent-os/docs/skill-triggers.md
```

---

## Self-review

### Spec coverage

| Requirement | Task |
|-------------|------|
| `agent-os/agents/`, `agent-os/skills/`, `agent-os/rules/` moved from `.cursor/` | Task 1 |
| `.cursor/agents`, `.cursor/skills`, `.cursor/rules` symlinks | Task 1 |
| `.claude/agents`, `.claude/skills` symlinks (Claude Code native) | Task 1 |
| `agent-os/hooks/skill-reminder.sh` + `.claude/hooks` symlink | Task 2 |
| `agent-os/docs/` reference files (platform-access, catalog, principles, triggers) | Task 3 |
| Agent files reference `agent-os/docs/platform-access.md` | Task 4 |
| Internal skill paths updated to `agent-os/` | Task 5 |
| Internal rule paths updated to `agent-os/` | Task 6 |
| Claude Code hooks + allowlist in `.claude/settings.json` | Task 7 |
| CLAUDE.md references `agent-os/` | Task 8 |
| AGENTS.md references `agent-os/` (Codex entry point) | Task 9 |
| cursor-agent-system.md updated | Task 10 |
| MCP config at `agent-os/mcp/`; `.cursor/`, `.claude/`, root symlinks | Task 11 |

### What does NOT change

- The 36 skills, 42 rules, 8 agents — content unchanged, only location
- Cursor's glob auto-attach behavior — symlinks are transparent to Cursor
- Pre-commit gates — they check `src/` structure, not `.cursor/` or `agent-os/`
- `be-skill-index` — stays canonical on the Cursor side; `agent-os/docs/skill-triggers.md` is the cross-platform equivalent

### Windows caveat

Symlinks require Developer Mode or elevated permissions on Windows.
If Windows support is needed in future, replace symlinks with a
`pnpm sync:ai` script that copies `agent-os/agents`, `agent-os/skills`, `agent-os/rules`
into `.cursor/` on change.
