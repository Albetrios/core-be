# Codebase Audit Loop

A **living audit log**, appended by a `/loop`-driven review that rotates through a
fixed set of perspectives. Unlike the dated snapshots elsewhere in this folder, this
is a repeatable *procedure*, not a point-in-time report — it is meant to be re-run and
extended over time.

**Analysis only.** The loop reads and reasons; it does **not** change code. Each
iteration records findings for a human (or a follow-up implementation session) to
action. Fixes land as ordinary PRs and are then noted back here under **Resolved**.

## How to run

Drive it with the built-in `/loop` skill, pointing each cycle at a read-only review
(for a diff-scoped pass, [`/be-pre-merge-review`](../../agent-os/commands/be-pre-merge-review.md);
for a whole-repo pass, an explicit perspective prompt):

```text
/loop 10m review the codebase for the next perspective in docs/reviews/codebase-audit-loop.md
```

Each cycle:

1. Picks the **next perspective** in the rotation (wrap around after the last).
2. Appends an `## Iteration N — <perspective> (<date>)` section using the schema below.
3. Records `### Findings`, `### Verified OK`, and `### Resolved` (link the fixing PR).

Keep history append-only — do not rewrite prior iterations; supersede a finding by
adding a later **Resolved** entry that references it.

## Per-finding schema

Every finding is one row:

| Field | Meaning |
| --- | --- |
| **Area** | Subsystem or domain (e.g. `tenancy/rls`, `billing/idempotency`, `queue/dlq`) |
| **Severity** | Critical > High > Medium > Low > Info (see below) |
| **Current** | `file:line` pointing at the code as it stands |
| **Suggestion** | The proposed change, concretely |
| **Pros (+)** | Why it is worth doing |
| **Cons (−)** | Cost, risk, or reason it might not be worth it |

**Severity scale:** `Critical` (data loss / tenant leak / auth bypass) · `High`
(correctness or security bug under realistic input) · `Medium` (latent bug, missing
guard, or scale risk) · `Low` (hygiene, clarity) · `Info` (observation, no action).

## Perspective rotation

Backend-specific lenses, rotated one per cycle so no single pass has to hold
everything at once:

1. **RLS & tenant isolation** — every tenant table ENABLE + FORCE RLS with USING + WITH CHECK; `app.current_organization_id` set on every query path; workers use context wrappers.
2. **Idempotency & money/state mutations** — `X-Idempotency-Key` writes, post-commit replay, Stripe mutation keys, no double-charge/double-apply.
3. **Worker / queue resilience** — pull-based workers, retries, DLQ routing, poison-job handling, graceful shutdown.
4. **SQL & index design** — FK indexes, partitioning, constraint naming, N+1s, capped counts, soft-delete filters.
5. **Auth, session & CSRF, rate limits** — JWT handling, session cookie + Origin checks, per-route limits, captcha on public forms.
6. **Secret redaction & outbound hardening** — logger redaction, outbound-fetch timeouts, circuit breakers, no secrets in responses/caches.
7. **Data lifecycle & retention** — soft-delete vs immutable ledgers, retention cleanup contexts, tombstone reads.
8. **Converged / residual** — re-check prior findings, cross-cutting drift, anything the single-lens passes missed.

## Iteration log

<!-- Append new iterations below. Copy the template, do not edit earlier entries. -->

### Iteration template

```markdown
## Iteration N — <perspective> (<YYYY-MM-DD>)

### Findings

| Area | Severity | Current | Suggestion | Pros (+) | Cons (−) |
| --- | --- | --- | --- | --- | --- |
| … | … | `path:line` | … | … | … |

### Verified OK

- <what was checked and found sound>

### Resolved

- <finding> → fixed in <PR link>
```
