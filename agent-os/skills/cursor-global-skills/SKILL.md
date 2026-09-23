---
name: cursor-global-skills
description: Reference for Cursor-built-in skills in ~/.cursor/skills-cursor/. Use when deciding whether a task needs a project skill (core-be) or a global Cursor skill. Not invoked for domain/API work.
indexNote: reference only
---

# Cursor global skills (reference)

These skills ship with **Cursor** under `~/.cursor/skills-cursor/`. They are **not** part of the core-be repo. Use **skill-index** and `agent-os/skills/*` for backend work in this project.

## When to use global vs project skills

| Task                                               | Use                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| New domain, routes, tests, migrations, seeds       | **core-be** skills (`skill-index` first)                                           |
| PR CI failures, merge conflicts, review comments   | **pr-babysit** (project) — or global **babysit** if project skill unavailable      |
| Diagnose one failing CI check on a PR              | **ci-investigator** (project)                                                      |
| Split branch into multiple PRs                     | **split-to-prs** (project) — domain-aware slices                                   |
| Create/edit project `.cursor/skills` or rules      | **create-skill**, **create-rule** (global)                                         |
| Edit `agent-os/agents/` subagent definitions        | **create-subagent** (global)                                                       |
| Cursor hooks (`hooks.json`)                        | **create-hook**                                                                    |
| Cursor IDE settings / extensions.json              | **update-cursor-settings** (user); **ide-productivity-guard** (project `.vscode/`) |
| Programmatic Cursor agents (`@cursor/sdk`)         | **sdk**                                                                            |
| Rich canvas UI (charts, timelines, MCP dashboards) | **canvas**                                                                         |
| CLI status line customization                      | **statusline**                                                                     |
| Migrate `.mdc` rules → skills format               | **migrate-to-skills** (one-time; `disable-model-invocation`)                       |
| Custom subagent definitions                        | **create-subagent**                                                                |

## Global skill catalog

| Skill                      | Purpose                                                    |
| -------------------------- | ---------------------------------------------------------- |
| **automate**               | Create Cursor Automations (usually not needed for core-be) |
| **babysit**                | Keep a PR merge-ready: triage comments, conflicts, CI      |
| **canvas**                 | Standalone React canvas for visual/analytical deliverables |
| **create-hook**            | Author Cursor hook scripts and `hooks.json`                |
| **create-rule**            | Author `agent-os/rules/*.mdc`                               |
| **create-skill**           | Author `SKILL.md` files (project or user)                  |
| **create-subagent**        | Define custom subagent types                               |
| **loop**                   | Recurring prompt intervals (usually not needed for core-be) |
| **migrate-to-skills**      | Convert rules/commands to Agent Skills format              |
| **sdk**                    | Cursor TypeScript SDK for external automation              |
| **shell**                  | Shell/command specialist (subagent)                        |
| **split-to-prs**           | Split work into small reviewable PRs                       |
| **statusline**             | Customize CLI status line                                  |
| **update-cli-config**      | Cursor CLI configuration                                   |
| **update-cursor-settings** | VS Code/Cursor `settings.json`                             |

## Skills you usually do not need

- **migrate-to-skills** — unless actively converting legacy rules
- **create-subagent** / **shell** — unless building custom agent workflows outside core-be conventions
- **automate** / **loop** — automation outside normal PR/feature workflow

## core-be project skills (45)

**45 total** — 42 actionable skills plus **skill-index** (meta) and **cursor-global-skills** (this reference). **lint-warnings-handler** is a detail skill invoked via **code-smells-and-best-practices**, not counted separately.

For the full list and triggers, read **`agent-os/skills/skill-index/SKILL.md`**.

Project copies of common global workflows: **pr-babysit**, **split-to-prs**, **ci-investigator**, **contract-test-maintainer**, **chaos-test-maintainer**.
