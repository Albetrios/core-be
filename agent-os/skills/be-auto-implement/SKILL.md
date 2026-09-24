---
name: be-auto-implement
description: Master orchestrator — given a requirement in the requirement.template.md format, pick the matching skill chain from chains.json, run its steps in order, run each step's gate as a stop-on-red checkpoint, and finish with the pre-merge-review pipeline. Use to drive a whole requirement end-to-end without hand-listing steps.
indexNote: workflow orchestrator — runs a chain end-to-end with per-step gates
---

# be-auto-implement — requirement → chain → gates → review

The **master orchestrator**. It owns no procedure of its own: it selects an existing
**chain** ([`agent-os/skills/chains.json`](../chains.json)), runs that chain's steps in
order — each step is an existing skill invoked by name — runs the step's **gate** as a
checkpoint, **stops on the first red**, and ends with the **pre-merge-review** pipeline
([`agent-os/agents/pipelines.json`](../../agents/pipelines.json)). No step list is duplicated
here; the chains and pipelines are the single source.

## Input

A requirement in the 9-section format of
[`docs/getting-started/requirement.template.md`](../../../docs/getting-started/requirement.template.md)
(draft it with **`/be-build-requirement`** first if the user gave a one-line task). The
**section 1 placement** (domain / sub-domain / tables / async side-effects) selects the chain.

## 1. Pick the chain (no guessing the ★ structural items)

Map the requirement to exactly one entry chain from `chains.json` by its trigger:

| Requirement is primarily…                          | Chain (chains.json)   |
| -------------------------------------------------- | --------------------- |
| a new domain or sub-domain (the full DAG)          | **new-domain**        |
| a new/changed table (schema, no new domain)        | **schema-change**     |
| a new/changed API route (no new table)             | **route-change**      |
| a new event / queue / worker                       | **worker-change**     |

A requirement that spans several (e.g. new domain **with** routes and a worker) runs the
**new-domain** chain, which already composes the others' steps. Run `pnpm agent-os:plan-skills <changed-files>`
to have the planner confirm the chain(s) from the actual diff.

## 2. Run the chain's steps in order (invoke each skill by name)

Read `chains.json` and invoke each `steps[]` skill **in order**, then its `optional[]` if the
requirement warrants it. Each step is a real skill (consult **be-skill-index** for what it does).
Do **not** re-list or reorder steps here — the chain is authoritative.

## 3. Checkpoint after every step — stop on red

After each step, run that step's **gate** and do not proceed to the next step until it is green.
The gate for a step is the command its owning skill / the definition-of-done enforces (the same
map `gate-failure-hint.sh` uses). Practical checkpoints by chain:

| Chain          | Per-step / end gate to run at the checkpoint                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| route-change   | `pnpm routes:catalog:check` · `pnpm validate:route-schema-docs` · `pnpm validate:route-success-statuses` · `pnpm docs:check` |
| schema-change  | `pnpm db:migrate:lint` · (RLS review) · `pnpm validate:domain:strict`                                    |
| worker-change  | `pnpm test:unit` for the worker · `pnpm tsdoc:check`                                                     |
| new-domain     | all of the above, per the composed steps                                                                |
| **every step** | `pnpm validate` (lint + format + typecheck) and, for agent-os edits, `pnpm agent-os:check`               |

If a gate is **red**, this is a **checkpoint**: fix within the owning skill, re-run the gate,
and only then continue. Never run a later step over a red gate.

## 4. Finish with the review pipeline

When the chain's steps are green, run the **pre-merge-review** pipeline from `pipelines.json`
(be-sql-design-reviewer → be-production-hardening-reviewer → verifier) and address blocking findings —
each reviewer hands its finding to the procedural skill that fixes it (`pipelines.json` `handoff`).
Then the change is done per **be-change-completeness-guard** (own tests, cross-cutting suites, docs,
rules, and skills all moved with it).

## Contract

- References chains and pipelines **by name only** — if a chain's steps change, this skill
  follows automatically.
- Stops on the first red gate (checkpoint) — never bulldozes a broken step.
- Ends every run at **pre-merge-review**; releases go through **be-path-to-production-gate**, not here.

See [[be-skill-index]] for the chain/pipeline catalog and [[be-change-completeness-guard]] for the
definition-of-done.
