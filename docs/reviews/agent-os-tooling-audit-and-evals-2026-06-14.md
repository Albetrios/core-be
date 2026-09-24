# agent-os AI-tooling — audit, roadmap & evals/enforcement build (2026-06-14)

> Point-in-time snapshot. Records an audit of the `agent-os/` AI-tooling bundle, the
> "open-loop → closed-loop" strategy it motivated, and the three PRs that implemented the
> first wave. Do not rewrite history; add a new dated file for future work.

## TL;DR

The `agent-os/` bundle (skills, rules, agents, hooks) was excellent at **authoring** AI guidance but had no mechanism to **enforce** it or detect when it drifted — an *open loop*. An audit found 7 of 37 skills had silently drifted (wrong counts, dead paths, a hook hardcoded to one developer's home directory). This session closed the loop in three merged PRs:

| PR | Theme | Outcome |
| -- | ----- | ------- |
| [#595](https://github.com/nikunjmavani/core-be/pull/595) | **Evals harness** | `agent-os/evals/` integrity + routing gate, wired into `ci:local`/`ci:quality`; fixed all drift it found |
| [#596](https://github.com/nikunjmavani/core-be/pull/596) | **Enforcement** | PreToolUse edit-blocker + SessionStart routing-map loader |
| [#597](https://github.com/nikunjmavani/core-be/pull/597) | **Skill gaps** | `be-rls-tenant-isolation-guard` + `be-idempotency-guard` skills |

The bundle is now **39 skills / 26 sync rules / 9 agents**, and every count, cross-reference, hook path, routing rule, and cited file path is self-validated by `pnpm agent-os:check` + `pnpm agent-os:triggers:strict`, both gating CI.

## 1. Context

The session began as an audit request: *"audit all skills, rules, agents and hooks (and what we can add), and any other sections."* The `agent-os/` directory is the single source of truth for all AI tooling, surfaced to Claude Code and Cursor via `.claude/` and `.cursor/` symlinks.

## 2. Audit findings

**Inventory at the start:** 37 skills, 38 Cursor rules (24 `*-sync.mdc` + 14 core), 9 agents, 2 hooks (a PostToolUse `skill-reminder.sh` + an inline `Stop` echo), and an MCP config.

**Verified drift (all confirmed against the filesystem):**

- **Stale counts** — `be-skill-index` said "36 skills" (37 on disk); `skill-triggers.md` said "22 sync rules" (24 on disk); `agents-catalog.md` said "8 agents" (9 on disk, `be-changelog-reviewer` missing from the table).
- **Broken hook** — `.claude/settings.json` (git-tracked) hardcoded `bash /Users/<one-developer>/…/skill-reminder.sh`, so the PostToolUse hook silently no-op'd for every other clone or git worktree.
- **Hook output never reached the model** — `skill-reminder.sh` echoed to stdout, which Claude Code shows to the *user*, not the model.
- **Dead path** — `.github/sync.config.json` referenced in a rule's `globs:` and body; the real manifest is `tooling/setup/setup.config.json`.
- **Routing gap** — `be-schema-generator` auto-triggers on `*.schema.ts` but was missing from the trigger map.
- **Moved-file references** — `database-handle.types.ts` (missing `/utils/`), two abbreviated `setup.config.json` paths, a stale `load-testing.md` flat path.

**Structural gaps (capabilities not yet used):** hooks were advisory-only (no PreToolUse enforcement) despite the repo's "hard rules, enforced by gates" ethos; no `.claude/commands/`; the 9 reviewer agents ran nowhere automatic; and there was no skill owning the two most security-critical surfaces (RLS/tenant isolation and idempotency).

## 3. The strategy: open-loop → closed-loop

The drift proved the thesis: the system optimized **authoring** guidance and *hoped* it was followed and stayed correct. The teams getting outsized leverage from AI agents in 2026 have moved to a closed loop — **author → enforce → measure → learn**. A frontier scan (evals-in-CI, mistake→guardrail loops, autonomous CI workers, parallel worktree fleets, OpenTelemetry on the agent, spec-driven scaffolds) framed six "moves"; this session executed the foundation.

## 4. What shipped

### PR #595 — Move 1: the evals harness

Treats the `agent-os/` bundle as **tested code**. Lives in [`agent-os/evals/`](../../agent-os/evals/):

- **`check.ts` (Tier 1 — deterministic gate).** Asserts: skill/sync-rule/agent counts match disk; the be-skill-index table equals the on-disk skill set and every listed path resolves; skill/agent frontmatter is valid (`name` matches directory); `.claude/settings.json` hook commands are portable (`$CLAUDE_PROJECT_DIR`, no hardcoded home path) and reference scripts that exist; every backtick-wrapped repo path in a skill/rule/doc resolves (allowlist in `ignore.json`). Zero-token, zero-flake.
- **`trigger-eval.ts` (Tier 2 — routing).** Resolves fixtures in `cases/triggers.json` against the globs in `skill-triggers.md` and fails if a changed file doesn't surface its expected skill(s).
- **Scripts** (mirroring `tsdoc:check`): `pnpm agent-os:check` / `:check:report` / `agent-os:triggers` / `:triggers:strict`.
- **Wired into `ci:local` and `ci:quality`** so drift fails CI forever.

On its first run the gate caught every drift item above; the PR then fixed them all (counts → 37/24/9, the portable hook path, the dead path, the moved refs, `be-schema-generator` into the map).

### PR #596 — Move 2: enforcement hooks

Moves enforcement of hard rules left from CI to the keystroke. New hooks in [`agent-os/hooks/`](../../agent-os/hooks/) (see [`agent-os/hooks/README.md`](../../agent-os/hooks/README.md)):

- **`guard-edits.sh` (PreToolUse, Edit/Write/MultiEdit).** **Denies** edits that violate a documented hard rule already enforced by global tests: `getRequestDatabase()` / `request-database.context` inside `*.worker.ts` / `*.processor.ts`; `../` parent-relative imports under `src/`; hand-edits to generated files (`pnpm-lock.yaml`, `routes.txt`, openapi specs, `project-identity.constants.ts`, dbml). **Fails open** — a missing `jq`, malformed input, or any error allows the edit, so a hook bug can never brick a session. Verified with 8/8 standalone cases.
- **`session-start.sh` (SessionStart).** Injects the skill routing map as `additionalContext`, so every session starts knowing which skill to run — baking in the "consult be-skill-index FIRST" mandate.
- The harness gained a **"hook scripts exist"** check (parses `settings.json` as JSON and verifies each referenced `agent-os/hooks/*.sh` resolves).

> Behavior note: the PreToolUse blocker is the one team-wide behavior change in this effort. It is conservative (only the three unambiguous rule classes above) and easy to tune in `guard-edits.sh` or remove from `settings.json`.

### PR #597 — the two missing guard skills

The audit's highest-value skill gaps — the most security-critical surfaces that no skill owned. Both are **review/guidance guards** grounded in the real implementation (two parallel readers extracted the mechanics), complementing the existing global/contract tests rather than duplicating them.

- **`be-rls-tenant-isolation-guard`** — ENABLE **and** FORCE row-level security, organization-scoped policies carrying both `USING` and `WITH CHECK`, the `app.current_organization_id` GUC (holding the organization `public_id`) set on every query path via a context wrapper, workers using context wrappers (never `getRequestDatabase`), tenant-scoped jobs carrying `organizationPublicId`, and the `EXPECTED_FORCE_RLS_TABLES` registry. Triggers on `*.schema.ts`, RLS migrations, `database/contexts/**`, tenant middleware, and workers/processors.
- **`be-idempotency-guard`** — the 8 `idempotencyRequired` writes (Idempotency-Key → 422 when missing/reused, 409 in-flight), the post-commit Redis replay (written from `request-lifecycle.middleware.ts`, never in `onSend`), secret-bearing bodies excluded from caching, and the client Idempotency-Key forwarded as Stripe's `idempotencyKey` on customer/subscription mutations. Triggers on the idempotency middleware/utils, `stripe.client.ts`, and the subscription/membership/organization routes.

Each skill ships with a `*-sync.mdc` rule (Cursor glob auto-attach, checklist inline), be-skill-index + be-cursor-global-skills count bumps (37→39), `skill-triggers.md` routing rows (24→26 sync rules), `skill-reminder.sh` hook reminders, and Tier-2 fixtures.

## 5. The closed loop, demonstrated

The harness repeatedly proved its worth *on its own changes*:

- It caught the 36→37 / 22→24 / 8→9 count drift on the very first run, then kept them honest on every subsequent PR.
- On #597, adding two skills bumped the disk count to 39 and the sync-rule count to 26; the gate **refused to pass** until `be-skill-index`, `be-cursor-global-skills`, and `skill-triggers.md` were all reconciled.
- Also on #597, the two new skills cite ~40 concrete file paths; the `referenced-path` check (promoted from warning to a hard error in #595's cleanup) **verified every one resolves** — turning "did I cite the right path?" from a hope into a gate.

## 6. Current state & how to use it

```bash
pnpm agent-os:check            # Tier-1 integrity gate (CI)
pnpm agent-os:check:report     # verbose — every check + warnings
pnpm agent-os:triggers:strict  # Tier-2 routing gate (CI)
```

Both run inside `ci:local` and `ci:quality`. The only remaining harness warning is intentional: `be-changelog-reviewer` pins `model: sonnet` (a deliberate cost choice for a cheap changelog scan).

**Where things live**

| Path | What |
| ---- | ---- |
| [`agent-os/evals/`](../../agent-os/evals/) | The harness — `check.ts`, `trigger-eval.ts`, `cases/triggers.json`, `ignore.json`, `README.md` |
| [`agent-os/hooks/`](../../agent-os/hooks/) | `guard-edits.sh` (PreToolUse), `session-start.sh` (SessionStart), `skill-reminder.sh` (PostToolUse), `README.md` |
| `agent-os/skills/be-rls-tenant-isolation-guard/`, `…/idempotency-guard/` | The two new guard skills |
| `.claude/settings.json` | Hook wiring (portable `$CLAUDE_PROJECT_DIR` commands) + permission allowlist |

## 7. Remaining roadmap

Out of the six "moves", Move 1 and Move 2 shipped, and the top skill gaps were filled. Remaining (Move 5 — OpenTelemetry on the agent — was explicitly parked):

- **Move 3 — autonomous CI reviewer.** A label-gated `.github/workflows/claude-review.yml` running the existing read-only reviewer agents on a PR diff. The workflow file can ship dormant, but it **needs an `ANTHROPIC_API_KEY` repo secret** to run.
- **Slash commands** — `.claude/commands/` for `/be-new-domain`, `/be-ship`, `/audit-routes`, `/triage-ci`. Fully buildable; the natural home is `agent-os/commands/` + a `.claude/commands` symlink, matching the existing agents/skills/hooks symlink pattern.
- **Move 6 — spec-driven self-verifying scaffolds.** Best folded into `/be-new-domain` with a generate → run-gates → self-correct loop (the `be-verifier` agent is half of this already).
- **Move 4 — parallel worktree fleets.** A usage pattern for multi-phase campaigns; documentation rather than code.
- **Move 2 (continued) — mistake → guardrail loop.** Use the `hookify` plugin to turn observed mistakes into new PreToolUse blocks, plus a shared `agent-os/decisions/` ADR log for team-visible agent memory.

## References

- PRs: [#595](https://github.com/nikunjmavani/core-be/pull/595), [#596](https://github.com/nikunjmavani/core-be/pull/596), [#597](https://github.com/nikunjmavani/core-be/pull/597)
- Harness: [`agent-os/evals/README.md`](../../agent-os/evals/README.md)
- Hooks: [`agent-os/hooks/README.md`](../../agent-os/hooks/README.md)
- Routing map under test: [`agent-os/docs/skill-triggers.md`](../../agent-os/docs/skill-triggers.md)
- Skill index: [`agent-os/skills/be-skill-index/SKILL.md`](../../agent-os/skills/be-skill-index/SKILL.md)
