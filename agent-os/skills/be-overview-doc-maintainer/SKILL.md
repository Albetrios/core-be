---
name: be-overview-doc-maintainer
description: Authors and maintains per-folder <folder>.overview.md files following one of four templates (A.1 domain, A.2 sub-domain, A.3 infrastructure/shared module, A.4 test suite). Use when adding a new domain, sub-domain, infrastructure module, or test suite folder, or when an existing <folder>.overview.md is stale.
trigger: src/**/*.overview.md
triggerNote: Per-folder overview docs
indexNote: author per-folder <folder>.overview.md (A.1–A.4 templates)
---

# Overview doc maintainer (core-be)

Owns the hand-authored **`<folder>.overview.md`** at every documentable folder under `src/`. Each folder uses one of four templates depending on its role; the validator picks the right template from the folder path.

| Template | Variant id | When |
| --- | --- | --- |
| A.1 — Domain | `A.1-domain` | `src/domains/<domain>/<domain>.overview.md` |
| A.2 — Sub-domain (incl. nested) | `A.2-sub-domain` | `src/domains/<domain>/sub-domains/<sub>/<sub>.overview.md` and any nested children |
| A.3 — Infrastructure or shared module | `A.3-infra-shared` | `src/infrastructure/<module>/<module>.overview.md`, `src/shared/<module>/<module>.overview.md`, `src/core/<module>/<module>.overview.md`, `src/scripts/<module>/<module>.overview.md` |
| A.4 — Test suite | `A.4-test-suite` | `src/tests/<suite>/<suite>.overview.md` |

## When to run

Run this skill when:

- A new folder appears under `src/domains/`, `src/infrastructure/`, `src/shared/`, `src/core/`, `src/scripts/`, or `src/tests/<suite>/` and needs an `<folder>.overview.md`.
- A domain's invariants change (new RLS contract, new lifecycle state, new cross-domain consumer) and the existing `<folder>.overview.md` is now stale.
- A reviewer flags an `<folder>.overview.md` as missing required sections.

## File header

Every `<folder>.overview.md` starts with the **bare backticked relative path** as line 1, no markdown link:

```markdown
`src/domains/billing/sub-domains/subscription/`

# Subscription
...
```

The first line is read by humans and AI agents as a self-locating breadcrumb when the file is opened directly (e.g. shown in chat or pasted into review). Keep it consistent across all `<folder>.overview.md` files.

## Templates

### A.1 — Domain (`src/domains/<domain>/<domain>.overview.md`)

Required H2 sections:

- `## Purpose`
- `## Key invariants`
- `## Sub-domains`
- `## Patterns used`
- `## Cross-domain flows`

Recommended additional H2 sections:

- `## Lifecycle` (Mermaid `stateDiagram-v2` showing the domain aggregate's state transitions)
- `## Events` (emits / consumes; cross-link to event handler files)
- `## External integrations`
- `## Failure modes`
- `## Policy constants` (cross-link to `src/POLICIES.md`)
- `## Related runbooks`

Cross-links: every entry under `## Patterns used` should link to a section in `src/PATTERNS.md`. Every entry under `## Cross-domain flows` should link to a section in `src/FLOWS.md`. Use markdown links, not anchor text only.

### A.2 — Sub-domain (`src/domains/<domain>/sub-domains/<sub>/<sub>.overview.md` and nested children)

Required H2 sections:

- `## Purpose`
- `## Key invariants`
- `## Lifecycle` (Mermaid `stateDiagram-v2`)

Add a `Parent:` line directly under the H1 to make the parent traversable. The relative path from a sub-domain's `<folder>.overview.md` to its parent domain's `<folder>.overview.md` is `../../<folder>.overview.md` (e.g. `src/domains/billing/sub-domains/subscription/subscription.overview.md` → `src/domains/billing/billing.overview.md`). For nested sub-domains, the parent link should be the immediate parent sub-domain at `../<folder>.overview.md`. Format the line as a regular markdown link: `Parent:` followed by `[<domain-display-name>]` followed by `(<relative-path>)` — for a top-level sub-domain, the relative path is `../../<folder>.overview.md`; for a nested sub-domain, `../<folder>.overview.md`.

Recommended additional H2 sections:

- `## Events`
- `## External integrations`
- `## Failure modes`
- `## Policy constants`

### A.3 — Infrastructure or shared module (`src/infrastructure/<module>/<module>.overview.md`)

Required H2 sections:

- `## Purpose`
- `## Design decisions`

Recommended additional H2 sections:

- `## Operational concerns` (timeouts, pool sizing, eviction, runbook links)
- `## External dependencies`
- `## Tuning parameters`
- `## Failure modes`

`## Design decisions` is the heart of the file: it documents *why* the chosen library / pattern / interface was picked over plausible alternatives. If you can't articulate at least two design decisions, the module is probably too small for its own folder.

### A.4 — Test suite (`src/tests/<suite>/<suite>.overview.md`)

Required H2 section:

- `## Purpose`

Recommended additional H2 sections:

- `## Test types`
- `## How to run` (exact `pnpm test:<suite>` command)
- `## Fixtures and helpers`
- `## Dependencies` (Postgres? Redis? Toxiproxy? k6?)
- `## Failure modes`

## How to add a new `<folder>.overview.md`

1. Determine the folder's role and pick the matching template.
2. Read the source files in the folder to understand purpose, invariants, lifecycle.
3. Cross-reference relevant entries in `src/PATTERNS.md` and `src/FLOWS.md`.
4. Author the file with the required H2 sections plus relevant recommended sections.
5. Confirm all required H2 sections are present for the chosen template.
6. Run `pnpm docs:lint` to catch markdown formatting issues.

## Anti-patterns

- ❌ Mentioning an invariant in `## Key invariants` without enforcing it somewhere (RLS policy, validator, test). Every invariant should be traceable to code.
- ❌ Drawing a Mermaid diagram with actor names that don't match the implementation classes. Use the actual class / function names.
- ❌ Putting a runbook link to a doc that doesn't exist yet. Either create the doc (via **be-docs-maintainer**) or omit the link.
- ❌ Authoring `<folder>.overview.md` for a `factories/` or `helpers/` directory — those don't carry their own narrative. The folder must contain real source files.

## Cross-skill triggers

- Mentioning a pattern not in `src/PATTERNS.md` → invoke **be-system-narrative-maintainer** to add the pattern entry.
- Mentioning a flow not in `src/FLOWS.md` → invoke **be-system-narrative-maintainer** to add the flow entry.

## Related references

- Worked examples already in the repo: every `<folder>.overview.md` under `src/`.
- Architecture overview: [`docs/reference/architecture/documentation-system.md`](../../../docs/reference/architecture/documentation-system.md)

---

**Related skills:** [be-system-narrative-maintainer](../be-system-narrative-maintainer/SKILL.md) · [be-docs-maintainer](../be-docs-maintainer/SKILL.md)
