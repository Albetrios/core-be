---
name: be-docs-maintainer
description: Keeps docs/ discoverable and consistent. Use when adding, renaming, or reorganizing docs; updates the index and cross-links so references stay correct.
trigger: docs/**/*.md
triggerNote: Hand-written docs — index + cross-links
indexNote: keep docs/ index + cross-links consistent on add/rename/move
---

# Docs maintainer (core-be)

## Purpose

When **documentation under `docs/`** is added, renamed, or reorganized, this skill ensures the doc index and all cross-references stay correct so docs remain discoverable and links do not break.

## When to use

- **Trigger**: Added, renamed, or moved any hand-written file under `docs/` (markdown only; exclude generated `docs/openapi/`, `postman-collection.json`, `routes.txt`).
- **Trigger**: Changed links from README, CLAUDE, skills, or rules to a doc in `docs/`.
- **Out of scope**: hand-written narratives **inside** `src/` (`src/OVERVIEW.md`, `src/PATTERNS.md`, `src/FLOWS.md`, `src/POLICIES.md`, every `src/<area>/<area>.overview.md`). Those are owned by **be-system-narrative-maintainer** / **be-overview-doc-maintainer**. Per-symbol docs live in TSDoc and are owned by **be-tsdoc-export-guard**. This skill stays focused on `docs/`.

## Responsibilities

1. **Index**  
   Ensure [docs/README.md](../../../docs/README.md) exists and lists all hand-written docs by use case (Getting started, Development workflow, Deployment, Features and tooling, Reference, Reviews). Deployment sub-index: [docs/deployment/README.md](../../../docs/deployment/README.md). Use correct paths after any rename or move.

2. **Naming**  
   Hand-written docs live in **subfolders** with **lowercase kebab-case** filenames (e.g. `getting-started/setup.md`, `reference/testing/load-testing.md`). When adding a new doc, place it in the correct subfolder (`getting-started`, `process`, `deployment` with `setup/` · `ci-cd/` · `runbooks/`, `integrations`, `reference/<topic>`, `superpowers/` with `plans/` · `specs/`, or point-in-time `reviews/`) and use this convention. Avoid new markdown files at `docs/` root (except `docs/README.md` and generated artifacts). **CI/CD:** one canonical doc — `deployment/ci-cd/cicd-and-deployment.md` (do not add parallel flow/diagram-only copies).

   **Known subfolders:** `getting-started/`, `process/`, `deployment/` (setup/, ci-cd/, runbooks/), `integrations/`, `reference/`, `reviews/`, `superpowers/` (plans/, specs/ — AI-generated implementation plans and specs), `database/` (`core-be.dbml` — auto-generated database diagram).

3. **Cross-links**  
   When a doc is renamed or moved, search the repo for the old path and update:
   - [README.md](../../../README.md)
   - [CLAUDE.md](../../../CLAUDE.md)
   - `agent-os/skills/**/SKILL.md`
   - `agent-os/rules/**/*.mdc`
   - [.env.example](../../../.env.example)
   - [src/tests/load/k6/README.md](../../../src/tests/load/k6/README.md)
   - `.github/workflows/*.yml`

4. **Stub/redirect cleanup**  
   If a doc is only a redirect to another, consider removing the stub and updating all references to the target doc.

5. **Mermaid**  
   **GitHub renders Mermaid as diagrams** in repo Markdown. When adding or editing a doc that describes a **process, flow, or structure**, add a Mermaid diagram (one flow per diagram). Use camelCase or underscores in node IDs; quote edge labels that contain parentheses. Keep diagrams focused.

## Generated artifacts (do not edit by hand)

- `docs/routes.txt` — produced by be-route-catalog skill / `pnpm routes:catalog`
- `docs/openapi/` (openapi.json, openapi.\*.json) — produced by `pnpm docs:generate` / `pnpm docs:generate:multilang`
- `docs/postman-collection.json` — produced by `pnpm docs:postman`

Link to these from the index as needed; do not list them as hand-written docs in the index table (they are listed under Reference in [docs/README.md](../../../docs/README.md)).

## Checklist (when a doc is added, renamed, or moved)

1. Update [docs/README.md](../../../docs/README.md) so the doc appears in the right use-case section with the correct path.
2. Search the repo for the old filename or path; update every reference.
3. If the doc describes a step-by-step flow or architecture, add or update a Mermaid diagram so GitHub shows it rendered.
4. Confirm no broken links: spot-check README, CLAUDE, and the doc index.

---

**Related skills:** [be-docs-audit](../be-docs-audit/SKILL.md) · [be-overview-doc-maintainer](../be-overview-doc-maintainer/SKILL.md) · [be-system-narrative-maintainer](../be-system-narrative-maintainer/SKILL.md)
