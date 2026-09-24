---
name: be-change-completeness-guard
description: Definition-of-done for any code change in core-be — propagate every edit to all the artifacts that mirror it: its own tests at the right layer, the cross-cutting suites (security, integration, load/k6, global, chaos, contract), docs (OVERVIEW, reference, TSDoc, .env.example), agent-os rules, and skills (counts, trigger maps, hardcoded route/constant sets). Use after editing any src/ code, middleware, config, route, constant, or shared count so nothing that describes or verifies the change is left stale.
trigger: src/**/*.ts
triggerNote: Finishing any code change — own tests + cross-cutting suites + docs + rules + skills move with it
indexNote: definition-of-done — propagate a change to its tests, cross-cutting suites, docs, rules, skills
---

# Change completeness guard (core-be)

## The rule

A change is **not done** when the code compiles and one test passes. It is done when
**every artifact that mirrors the change has moved with it.** In this repo a single fact
is often stated in five places at once — code, its own test, a cross-cutting test, a doc,
and a skill — so a change that touches only the code leaves the other four stale, and the
drift is invisible until a human (or CI months later) trips over it.

> Worked example (the lesson this skill encodes): a route-set size lived as the literal
> "8 writes" in the `be-idempotency-guard` skill, in `docs/reference/api/frontend-auth-guide.md`,
> and in two test comments under `src/tests/security/` and `src/tests/load/`. Changing the
> route set in code (8 → 13) compiled and passed its own e2e, but left **four** stale mirrors.
> This guard exists so the next such change updates all five layers in the same commit.

## The five layers — propagate every change through all of them

After **any** code edit, walk this checklist. Skip a layer only when you can name why it
does not apply (not by forgetting it).

1. **Its own tests — at the right layer.** Add/update/delete the test that directly covers
   the change, in the layer the testing pyramid dictates (pure function → `src/tests/unit/`
   or a co-located `__tests__/unit/`; route/DB behaviour → domain `__tests__/*.test.ts` e2e).
   A change with **no** test delta is a red flag — state why (pure rename, comment-only, or
   already covered by an existing assertion you can point to). Run **be-test-generator**.
2. **Cross-cutting tests.** Ask whether the change is also asserted by a *shared* suite, and
   update that suite too (or confirm it stays green by design):
   - `src/tests/security/` — auth, idempotency, rate-limit, header, secret-leak policy.
   - `src/tests/integration/` — multi-component flows.
   - `src/tests/global/` — repo-wide invariants (import paths, no-direct-db-in-services,
     snake-case body keys, etc.); these fail loudly when a structural rule is broken.
   - `src/tests/contract/` — outbound Stripe/Resend/S3 contracts (run **be-contract-test-maintainer**).
   - `src/tests/chaos/` — fault-injection (run **be-chaos-test-maintainer**).
   - `src/tests/load/k6/scenarios/` — k6 throughput/limits; update a scenario or its env
     defaults when a tuning knob (pool size, cap, tolerance) moves.
   - `src/tests/performance/` — latency/budget guards.
   > Convention (do not over-add): the mechanism is tested **once** at the layer that owns it,
   > on a representative case — not duplicated into every suite. A route-agnostic middleware is
   > proven on one representative route; a shared util is unit-tested directly. Mirror the
   > convention of the suites already present rather than fanning the same assertion across layers.
3. **Docs.** Update every doc that states what you changed: the nearest `src/**/*.overview.md`,
   the relevant `docs/reference/**`, TSDoc on any added/renamed export (gate: `pnpm tsdoc:check`),
   route `schema` blocks for OpenAPI, and `.env.example` for any new env var. Run the matching
   skill (**be-overview-doc-maintainer**, **be-docs-maintainer**, **be-tsdoc-export-guard**,
   **be-route-schema-doc-guard**, **be-env-schema-add**).
4. **Rules.** If the change alters a convention, an enforced count, or a file-pattern policy,
   update the relevant `agent-os/rules/*.mdc` (and the always-applied rules table). Run
   **be-structure-maintainer**.
5. **Skills.** If you added/renamed a skill, or a skill hardcodes a fact you just changed
   (a count, a route set, a path list), update it — and the indexes that count skills:
   `agent-os/skills/be-skill-index/SKILL.md` (the `N project skills` count + the skill table),
   `agent-os/skills/groups.json` (every skill in exactly one group), `agent-os/docs/skill-triggers.md`,
   and the `N project skills` count in `CLAUDE.md` / `AGENTS.md`. Run **be-structure-maintainer**;
   the `pnpm agent-os:check` gate asserts these stay in sync.

## Trace-the-change table — what mirrors each kind of edit

| When you change…                                   | …also update (same commit)                                                                 | Skill / gate                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| A route (`*.routes.ts`)                            | params/body schema, `docs/routes.txt`, OpenAPI, e2e test, seeds                              | **be-api-contract-guard** → **be-route-catalog**     |
| A `config` flag set on a *set* of routes           | every route in the set, the count/doc that names the set, the policy test that asserts it    | **be-api-contract-guard** / **be-idempotency-guard** |
| A Drizzle schema (`*.schema.ts`)                   | migration, RLS, seeds, sql-design review, repo + e2e tests                                   | **be-schema-generator** → **be-db-migration-maintainer** |
| An env var (`env-schema.ts`)                       | `.env.example`, hosted-env mapping, the unit test asserting the default, docs                | **be-env-schema-add**                             |
| A user-facing string                               | `en` **and** `es` locale keys; no raw literal in code                                        | **be-i18n-message-guard**                         |
| An event / queue / worker                          | registry wiring, durability/metric, worker + emit tests                                      | **be-workers-events**                             |
| A tuning constant (pool size, cap, tolerance, TTL) | every test/doc/k6-scenario that restates the number; the registry that owns it               | **be-production-hardening-guard** + this guard    |
| A shared count or hardcoded list (in code or docs) | **grep the literal repo-wide** and fix every mirror (see below)                              | this guard                                     |
| A public export (added/renamed)                    | TSDoc summary (+ `@remarks` on service/worker/policy), importers                             | **be-tsdoc-export-guard**                         |
| A folder layout / file move                        | `CLAUDE.md`, `README.md`, rules, skills, OVERVIEW                                            | **be-structure-maintainer**                       |
| A skill (added/renamed)                            | be-skill-index count + table, `groups.json`, `skill-triggers.md`, `CLAUDE.md` / `AGENTS.md`     | **be-structure-maintainer** + `pnpm agent-os:check` |

## How to find every mirror of a change

1. **Grep the literal you changed** — a count (`8`/`13`), a route path, a constant name, a
   header, an env key — across `src/`, `docs/`, and `agent-os/`. Stale duplicates of a fact
   are the most common miss; the literal is the fastest way to find them.
2. **Consult the index first.** Open **be-skill-index** (`agent-os/skills/be-skill-index/SKILL.md`)
   and `agent-os/docs/skill-triggers.md`: the file-pattern → skill map tells you which owner
   skill(s) to run for the files you touched. Run only those (no duplicate invocations).
3. **Let the gates catch the rest.** `pnpm validate` (lint + types), `pnpm test:global`
   (repo-wide invariants), `pnpm routes:catalog:check`, `pnpm tsdoc:check`, `pnpm agent-os:check`
   (skill/rule/doc count sync), and the pre-commit guard each fail on a specific class of
   stale mirror. Treat a gate failure as "a mirror you missed," not noise.

## Verify

```bash
pnpm validate                 # lint + format + typecheck on the change
pnpm test:global              # repo-wide structural invariants (import paths, body-key casing, …)
pnpm agent-os:check           # skill/rule/doc counts + index ↔ disk in sync
pnpm guard:pre-commit         # the full local gate (mirrors CI sync checks)
```

Plus the card/skill-specific `pnpm test:*` for the layer you touched (see **be-test-generator**).

## Maintaining this skill

- This skill is **general** — it must stay free of any one feature's specifics (no per-domain
  counts or route lists here). When a concrete fact changes, fix it in its owner skill/doc, not here.
- If a new cross-cutting test suite or a new mirrored-artifact layer is added to the repo,
  add it to the five-layer checklist and the trace-the-change table.

Related: **be-skill-index** (which owner skill to run), **be-test-generator** (test layer/pyramid),
**be-structure-maintainer** (docs/rules/skills sync), **be-before-commit-guard** (the commit gate).
