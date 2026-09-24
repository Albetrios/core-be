---
description: Deep semantic audit — compare hand-written docs/skills/rules against the actual src tree
argument-hint: (no arguments)
allowed-tools: Bash, Read, Grep, Glob, Agent
---

Periodic (monthly) semantic drift audit. The deterministic layer is already
gated (`pnpm docs:links:check` verifies cited paths exist; generated artifacts
have their own `:check` gates) — this audit covers what scripts cannot: whether
narrative claims, enumerations, tables, and counts still **describe reality**.

1. Regenerate ground truth: `pnpm tool:project-structure-tree` (writes
   `docs/reference/architecture/src-structure-tree.txt`).
2. Fan out **four parallel read-only Explore agents**, each comparing one
   artifact family against the tree + direct `ls`, reporting only concrete
   mismatches (claimed-but-absent, present-but-undocumented where a section
   intends completeness, wrong names):
   - **CLAUDE.md** — domain/sub-domain mapping table, Infrastructure and Shared
     tree blocks, Testing section, Commands/namespace list, queue/events
     sections.
   - **agent-os skills + rules** — every `SKILL.md`/`.mdc` with embedded layout
     trees or enumerations (be-structure-maintainer, be-domain-generator,
     be-workers-events, be-test-generator, be-seed-maintainer, be-skill-index counts,
     skill-triggers table).
   - **Human docs** — README project layout + diagrams, `docs/README.md` index
     vs folders on disk, `docs/reference/architecture/*` enumerations,
     `src/{OVERVIEW,PATTERNS,FLOWS,POLICIES}.md`.
   - **Per-folder overviews + policy tests** — `*.overview.md` coverage gaps
     (folder whose siblings have one) and staleness; validator allowlists and
     global/policy tests for dead entries.
3. Fix every confirmed mismatch (skills edits require `pnpm agent-os:lock`),
   regenerate the tree if files were added, then run:
   `pnpm docs:links:check && pnpm agent-os:check && pnpm tool:project-structure-tree:check`.
4. Ship as a PR (never push to main) titled
   `chore(sync): monthly structure audit <YYYY-MM>` summarizing findings per
   family, including families that were clean.

Report: mismatches found per family, files fixed, and gates re-run.
