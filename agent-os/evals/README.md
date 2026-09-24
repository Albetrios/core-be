# agent-os evals

Treats the `agent-os/` bundle (skills, rules, agents, docs, hooks) as **tested code**, not just documentation. The bundle is a large, cross-referenced surface that drifts silently — stale counts, dead path references, index/disk divergence, non-portable hook commands. These evals turn that drift into a failing gate instead of a months-later human audit.

> **Why this exists:** a June 2026 audit found 7 of 37 skills had silently drifted (wrong counts, a dead `.github/sync.config.json` reference, a hook hardcoded to one developer's home path, `be-schema-generator` missing from the trigger map) with zero detection. This harness is the closed loop: **author → enforce → measure** instead of author → hope.

## Four tiers

| Tier | File | Question | CI |
| ---- | ---- | -------- | -- |
| **1 — integrity** | [`check.ts`](check.ts) | Is the bundle internally consistent? (deterministic, zero-token) | **Gates** — exits 1 on any error |
| **2 — triggers** | [`trigger-eval.ts`](trigger-eval.ts) | When file X changes, does the routing map surface the right skill(s)? | **Gates** — `agent-os:triggers:strict` in CI |
| **3 — outcomes** | [`outcome-eval.ts`](outcome-eval.ts) | In a real session, did the agent actually consult/invoke the skills it should have? | **Gates** — `agent-os:outcomes` (fixtures) in CI |
| **4 — guards** | [`guard-eval.ts`](guard-eval.ts) | Do the guard hooks actually block/escalate/flag what they claim — and fail open on garbage input? | **Gates** — `agent-os:guards` in CI |

## Run

```bash
pnpm agent-os:check            # Tier 1 gate (CI)
pnpm agent-os:check:report     # Tier 1 verbose — every check + warnings
pnpm agent-os:triggers         # Tier 2 report (local)
pnpm agent-os:triggers:strict  # Tier 2 gate (CI) — exits 1 on a missing route
pnpm agent-os:outcomes         # Tier 3 gate (CI) — score recorded session fixtures
pnpm agent-os:outcomes:live <transcript.jsonl>   # Tier 3 ad hoc — score one real session
pnpm agent-os:guards           # Tier 4 gate (CI) — adversarial guard cases + fail-open smokes
```

`pnpm agent-os:check`, `pnpm agent-os:triggers:strict`, `pnpm agent-os:outcomes`, and `pnpm agent-os:guards` are wired into `ci:local` and `ci:quality`.

## Tier 1 checks (`check.ts`)

| Check | Catches |
| ----- | ------- |
| Skill frontmatter & names | missing `name`/`description`, `name` ≠ directory |
| Skills lockfile provenance | a skill edited without relocking, a new skill never locked, a lock entry for a deleted skill (`skills-lock.json` hash drift) |
| Skill-index counts | "36 skills" when 37 exist |
| Skill-index ↔ disk | a skill on disk missing from the index table, an index row with no directory, an index path that doesn't resolve |
| Sync-rule count | "22 sync rules" when 24 `*-sync.mdc` exist |
| Agent catalog count & coverage | "All 8 agents" when 9 exist; an agent file absent from the catalog |
| Agent frontmatter | missing `name`/`description`; `model` pinned off `inherit` (warn) |
| Hook portability | `.claude/settings.json` hook hardcoding `/Users/…` instead of `$CLAUDE_PROJECT_DIR` |
| Referenced paths exist | a backticked `src/…` / `.github/…` path in any skill/rule/doc that doesn't exist |
| Chains have outcome fixtures | a chain in `chains.json` with no `cases/outcomes/<chain>-*.jsonl` fixture, or a fixture missing its `.expected.json` — the coverage rule is **new chain ⇒ new outcome case** |
| Sync rules ↔ skills/routing map | a `<skill>-sync.mdc` whose skill was renamed/deleted (error); a rule with no `globs`, or whose globs *and* skill name are all absent from `skill-triggers.md` (warn) |
| Repo name prefix | a skill, agent, command or rule this repo owns without the `be-` prefix; upstream skills (non-`local` `skills-lock.json` entries) are exempt |

Warnings (non-blocking): thin skill descriptions (< 80 chars, weak auto-trigger) and agents pinning a non-`inherit` model.

### Skills lockfile (`agent-os/skills-lock.json`)

Every skill's `SKILL.md` is hashed (sha256) and recorded with its `source` — `local` for home-grown skills, a github `org/repo` for vendored ones (e.g. `ponytail`). Tier 1 recomputes each hash and fails on drift, a new skill missing from the lockfile, or a lock entry for a deleted skill, so silent upstream drift or local tampering is caught. Workflow:

```bash
# edit a skill, then:
pnpm agent-os:lock         # recompute + rewrite hashes
# commit the SKILL.md and skills-lock.json together
pnpm agent-os:lock:check   # verify without rewriting (also part of agent-os:check)
```

### `ignore.json`

The referenced-path check allowlists intentionally-uncommitted paths (gitignored env templates, generated specs). Add an entry **only** when a path is deliberately absent — a genuine dead reference should be fixed, not ignored.

## Tier 2 cases (`cases/triggers.json`)

Each case maps a changed file to the skills the routing map must surface:

```json
{ "file": "src/domains/x/y/y.schema.ts",
  "expectSkills": ["be-sql-design-guard", "be-db-migration-maintainer", "be-schema-generator"] }
```

`trigger-eval.ts` converts the globs in `skill-triggers.md` to matchers, resolves each file, and reports expected skills the map fails to surface. Add a case whenever you wire a new file-pattern → skill route.

## Tier 3 — outcomes (`outcome-eval.ts`, `cases/outcomes/`)

Tier 2 proves the *map* is right; Tier 3 proves the routing **actually worked in practice**. It reads a session transcript (Claude Code JSONL, or any JSONL with `tool_use` blocks), extracts the **files edited** (Edit/Write/MultiEdit) and the **skills consulted/invoked** (a `Skill` tool call, or a `Read` of `agent-os/skills/<name>/SKILL.md`), computes the skills that *should* have run from `chains.json` steps + per-skill `trigger` frontmatter (the same sources the routing map is generated from), and emits a **scorecard**: expected vs actual, per file, with a hit rate.

- **Target hit rate for real sessions: ≥ 90%.** `agent-os:outcomes:live <transcript>` prints the scorecard and warns below target — run it on a real session to spot-check routing.
- **Fixtures gate CI deterministically.** Each `cases/outcomes/<name>.jsonl` is a recorded (sanitized) session; its `<name>.expected.json` declares the `hitRate` and precise `misses`. `agent-os:outcomes` asserts every fixture's computed scorecard matches its declaration — so a regression in routing behaviour (or in the scorer) fails CI. One fixture (`route-change-skipped-seed`) deliberately omits `be-seed-maintainer`: it scores 83% and names `be-seed-maintainer` as the miss, proving the scorer catches a skipped skill precisely.
- **Add a fixture** whenever you want to lock in a routing outcome: drop the transcript JSONL + an `.expected.json` next to it.
- **Coverage policy (gated by Tier 1):** every chain in `chains.json` must have at least one outcome fixture named `<chain>-*.jsonl`. Adding a chain without a fixture fails `agent-os:check`.

**Monthly ritual:** score a handful of recent real sessions with `agent-os:outcomes:live`; if the aggregate dips below 90%, the routing map or a skill description needs work (pair with the hook telemetry report and skill trigger-rate data).

## Roadmap

- ~~Promote Tier 2 to a gate~~ ✅ done — `agent-os:triggers:strict` gates CI alongside Tier 1.
- ~~Tier 3 — outcomes~~ ✅ done — `agent-os:outcomes` scores real session transcripts against the routing map and gates fixtures in CI.
- **Tier 3+ — output quality (LLM-judge).** Beyond "did the right skill run", score the *response* against a rubric/gold answer (faithfulness, completeness), gate on a calibrated threshold. Pairs with [DeepEval](https://github.com/confident-ai/deepeval) + an OTel trace store.
- **Telemetry-fed curation.** With Claude Code OpenTelemetry export + the hook telemetry log, fold real trigger-rate and cost data in — prune skills/hooks that never fire, harden the ones that do.

See [`agent-os/docs/skill-triggers.md`](../docs/skill-triggers.md) for the routing map under test.
