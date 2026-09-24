---
name: be-docs-audit
description: On-request full pass over docs: index, naming, Mermaid, cross-links. Use when the user asks to review or audit documentation, or after large reorganizations.
indexNote: on-request full docs/ audit (index, naming, Mermaid, cross-links)
---

# Docs audit (core-be)

## Purpose

Run a **full pass** over hand-written docs when the user asks to "review docs", "audit documentation", or similar, or after a large reorganization. This complements **be-docs-maintainer** (which runs on add/rename/move) with a deliberate review.

## When to use

- **Trigger**: User says "review docs", "audit documentation", "check docs", or similar.
- **Trigger**: After a large docs reorganization (e.g. new subfolders, many renames).

## Checklist

1. **Index**  
   Ensure every hand-written doc under `docs/` (in subfolders; no stray root `.md` except `docs/README.md`) is listed in [docs/README.md](../../../docs/README.md) under the correct use-case section, and deployment docs appear in [docs/deployment/README.md](../../../docs/deployment/README.md) where applicable.

2. **Naming**  
   Confirm subfolder + **lowercase kebab-case** filenames (e.g. `getting-started/setup.md`, `reference/testing/load-testing.md`). No UPPER-KEBAB in subfolders. Generated artifacts live in `docs/`: `openapi/` (openapi\*.json), `postman-collection.json`, `routes.txt`. Known subfolders include: `getting-started/`, `process/`, `deployment/`, `integrations/`, `reference/`, `reviews/`, `superpowers/` (plans/, specs/ — AI-generated implementation plans and specs), `database/` (`core-be.dbml` — auto-generated database diagram). Do not flag these as unexpected.

3. **Mermaid**  
   For each doc that describes a **process, flow, or structure**, confirm it has a Mermaid diagram (flowchart or sequence). Add one if missing so GitHub renders it.

4. **Cross-links**  
   Spot-check: README.md, CLAUDE.md, `agent-os/skills/**/SKILL.md`, `agent-os/rules/**/*.mdc`, src/tests/load/k6/README.md, .env.example, .github/workflows. Fix any references that still point to old flat paths (e.g. `docs/reference/load-testing.md` → `docs/reference/testing/load-testing.md`).

## Output

Report: (1) Index OK / gaps. (2) Naming OK / renames suggested. (3) Docs missing Mermaid. (4) Broken or stale links found and fixed (or listed for the user).

---

**Related skills:** [be-docs-maintainer](../be-docs-maintainer/SKILL.md)
