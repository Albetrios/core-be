---
name: be-system-narrative-maintainer
description: Maintains the four system-level documentation files at src/ root — src/OVERVIEW.md (platform overview), src/PATTERNS.md (cross-cutting patterns), src/FLOWS.md (end-to-end feature flows), src/POLICIES.md (platform policy constants). Use when adding a new domain, a new cross-cutting pattern, a new end-to-end flow, or a new policy constant in src/shared/constants/.
trigger: src/OVERVIEW.md, src/PATTERNS.md, src/FLOWS.md, src/POLICIES.md
triggerNote: System-level narratives
indexNote: maintain src/ OVERVIEW / PATTERNS / FLOWS / POLICIES
---

# System narrative maintainer (core-be)

Owns the four hand-authored, cross-domain narrative files that sit at `src/` root:

| File | Purpose |
| --- | --- |
| [`src/OVERVIEW.md`](../../../src/OVERVIEW.md) | Platform overview: what the product is, the architecture diagram, the domains, the cross-cutting patterns, the end-to-end flows, the tech stack. |
| [`src/PATTERNS.md`](../../../src/PATTERNS.md) | Cross-cutting patterns: tenant-isolation, audit-emission, idempotency, soft-delete, rls-context, transactional-outbox. Each pattern has Purpose / Where it lives / Implementation / How to apply. |
| [`src/FLOWS.md`](../../../src/FLOWS.md) | End-to-end feature flows: signup, login, organization-invitation, subscription-change, dunning. Each flow has Trigger / Sequence (Mermaid) / Side effects / Failure modes. |
| [`src/POLICIES.md`](../../../src/POLICIES.md) | Platform policy constants: every TTL, lockout window, cap, etc. has Value / Source / Rationale / Consequences of change / Last reviewed. |

## When to run

Run this skill when:

- A new **domain** is added under `src/domains/<domain>/` → update `src/OVERVIEW.md` (Domains table) and possibly add a new pattern row in `src/PATTERNS.md` if the domain introduces one.
- A new **cross-cutting pattern** is introduced (something used by 2+ domains) → add it to `src/PATTERNS.md`.
- A new **end-to-end flow** is added (any new user journey that spans 3+ domains or involves at least one external integration round-trip) → add it to `src/FLOWS.md`.
- A new **policy constant** is added under `src/shared/constants/` → add it to `src/POLICIES.md` with rationale + consequences + last-reviewed date.
- A reviewed policy constant changes value → update its row in `src/POLICIES.md` with the new last-reviewed date.

## Templates

Each file follows a fixed shape. Keep section names consistent across changes — the four narratives are read together by anyone onboarding to the codebase.

### Template F — `src/OVERVIEW.md`

Required sections:

- `## Purpose`
- `## Architecture at a glance` (Mermaid block diagram)
- `## Domains` (table)
- `## Patterns` (links to `src/PATTERNS.md` entries)
- `## Flows` (links to `src/FLOWS.md` entries)
- `## Policies` (summary; details in `src/POLICIES.md`)
- `## Tech stack`

First line: `` `src/` `` (bare path, backticked, no markdown link).

### Template G — `src/PATTERNS.md`

Required sections:

- `## Purpose`
- One H2 `## <pattern-name>` per pattern, each with H3:
  - `### Purpose`
  - `### Where it lives` (file paths)
  - `### Implementation` (Mermaid sequence / flowchart when not trivial)
  - `### How to apply`

First line: `` `src/` ``.

### Template H — `src/FLOWS.md`

Required sections:

- `## Purpose`
- One H2 `## <flow-name>` per flow, each with H3:
  - `### Trigger`
  - `### Sequence` (Mermaid sequence diagram)
  - `### Side effects`
  - `### Failure modes`

First line: `` `src/` ``.

### Template I — `src/POLICIES.md`

Required sections:

- `## Purpose`
- One H2 `## <CONSTANT_NAME>` per policy constant, each with bullets:
  - `**Value**`: the literal value.
  - `**Source**`: the canonical export file.
  - `**Rationale**`: why this number was chosen.
  - `**Consequences of change**`: what breaks if it's increased / decreased.
  - `**Last reviewed**`: ISO date.

First line: `` `src/` ``.

## How to add an entry

### Add a new domain

1. Read the domain's `<folder>.overview.md` (variant A.1 — written by **be-overview-doc-maintainer**).
2. Append a row to the Domains table in `src/OVERVIEW.md`.
3. If the domain introduces a new cross-cutting pattern, add it under `src/PATTERNS.md` (see below).
4. If the domain participates in a new end-to-end flow, add it under `src/FLOWS.md`.
5. Run `pnpm tsdoc:check` to confirm coverage budget is not regressed by any new exports referenced from the narrative.

### Add a new pattern

1. Identify the canonical implementation file(s) — usually a context wrapper, a middleware, or a service helper.
2. Add an H2 block under `src/PATTERNS.md` following Template G. Required H3 sections are `Purpose`, `Where it lives`, `Implementation`, `How to apply`.
3. Cross-link from any domain `<folder>.overview.md` whose `## Patterns used` list mentions this pattern.

### Add a new flow

1. Add an H2 block under `src/FLOWS.md` following Template H. The Sequence diagram should name the same actors as the implementation (controller → service → context → DB → event-bus → worker).
2. Cross-link from the participating domain `<folder>.overview.md` files in their `## Cross-domain flows` section.

### Add a new policy constant

1. Add the constant to the appropriate file under `src/shared/constants/` with a TSDoc `@remarks` block (rationale + consequences + last reviewed). The **be-tsdoc-export-guard** skill enforces that.
2. Add the matching H2 block under `src/POLICIES.md` following Template I.
3. Run `pnpm tsdoc:check` to confirm the new export carries the required `@remarks`.

## Anti-patterns

- ❌ Mentioning a pattern in a domain `<folder>.overview.md` without adding it to `src/PATTERNS.md`.
- ❌ Adding a flow that crosses 3+ domains without an entry in `src/FLOWS.md`.
- ❌ Adding a policy constant without `## Consequences of change` (every value here is a deliberate trade-off; the table records the rationale).
- ❌ Changing a Mermaid actor name without updating the implementation or vice-versa — the diagrams are read alongside the code.

## Cross-skill triggers

- Adding a new policy constant → also invoke **be-tsdoc-export-guard** (the constant export needs `@remarks` describing rationale + consequences + last reviewed).
- Adding a new domain → also invoke **be-overview-doc-maintainer** (the new domain folder needs an `<folder>.overview.md`).

## Related references

- TSDoc coverage gate: [`tooling/tsdoc-coverage/`](../../../tooling/tsdoc-coverage/)
- Architecture doc: [`docs/reference/architecture/documentation-system.md`](../../../docs/reference/architecture/documentation-system.md)

---

**Related skills:** [be-overview-doc-maintainer](../be-overview-doc-maintainer/SKILL.md) · [be-tsdoc-export-guard](../be-tsdoc-export-guard/SKILL.md)
