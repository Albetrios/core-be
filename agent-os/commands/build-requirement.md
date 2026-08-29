---
description: Draft a requirement (tree first) for review, then build the production-ready slice
argument-hint: <a direct task — what you want in a line or two — or a filled form / path>
allowed-tools: Bash(pnpm*), Bash(git*)
---

Turn a requirement into a complete, production-ready vertical slice. **The normal input is a direct task** — a line or two of what you want (**$ARGUMENTS**, the conversation, or a path), not a filled form — so you **draft** the full document, get it **reviewed**, then build. The document format is the 9-section form in `docs/getting-started/requirement.template.md` (filled example: `docs/getting-started/requirement.example.md`; defaults: `docs/getting-started/requirement-intake.md`).

## 1. Draft the full requirement, then get it reviewed (you fill it, not the user)

The user normally gives a direct task, not the whole form. Build the document for them:

1. **Draft all 9 sections** of the form (`# Requirement:` + `## 1`–`## 9`: summary/placement, data model, public API, business logic, i18n, seed, tests [unit/integration/e2e/smoke/contract/chaos], non-functionals, file structure). Fill sensible defaults (`requirement-intake.md`) and infer the data model, API, logic, tests, and the **section-9 file tree** from the prompt.
2. **Mark everything you added** so the user sees exactly what to scrutinize: tag each value *you* inferred or defaulted (not what the user stated) inline with **`[assumed]`** — e.g. `- Public-id prefix: inv  [assumed]` — and lead the draft with an **"Assumptions I added — confirm or change"** list gathering those choices in one place, one line + reason each.
3. **Present the full draft for review** as one fenced block — the assumptions list first, then the **section-9 tree** (layout reviewed first), then sections 1–8. **Ask** (via `AskUserQuestion`) only the **unresolved** items from the Question catalog below — never guess the ★ (structural / irreversible) ones.
4. **Iterate**: apply each "change X", clear the `[assumed]` tag on anything the user confirms or edits, and re-present until they approve. The approved draft is the final document.

### Question catalog (ask only the unresolved items; ★ = never guess)

- **Placement** — ★ domain (auth · user · tenancy · billing · notify · audit · upload · new) · ★ sub-domain (new · extend) · ★ tenancy (organization-scoped/RLS · user-scoped · global)
- **Data model** — ★ new tables? (yes · reuse) · ★ lifecycle (soft-delete · hard delete · immutable ledger) · columns (type/null/unique/FK/CHECK) · public-id prefix · indexes (AI proposes · specify)
- **Public API** — ★ auth per route (public · authenticated · `org-permission:<code>` · global-role:admin) · endpoint shape (standard REST · custom) · pagination (cursor · offset · none) · ★ idempotency on writes (yes · no)
- **Business logic** — cross-domain (none · read · write service `<X>`) · ★ async side effects (none · event · event + queue + worker) · caching / rate limits (default · custom)
- **i18n / seed** — messages (AI proposes · specify) · seed (none · reference · bulk/faker count)
- **Tests** (multi-select) — unit · integration · e2e · smoke · contract · chaos
- **Non-functionals** — performance budget (default · p95 target) · security (standard RLS/tenant · specify PII/encryption/secrets)
- **Delivery** — target branch (main; hotfixes fix-forward via `fix/*`) · PR after build (no · yes → `/ship`)

Anything not ★ you may infer and tag `[assumed]`. This catalog is curatable — trim or extend it freely.

Do **not** start the build before the draft — the section-9 tree especially — is approved.

## 2. Run the build pipeline (each step is an existing skill — consult skill-index first)

1. **`/schema-complete`** — schema-generator → sql-design-guard → db-migration-maintainer → rls-tenant-isolation-guard.
2. **domain-generator** — repository → service → controller → dto/validator/serializer/types → container + route registration.
3. **`/route-complete`** — api-contract-guard → route-schema-doc-guard → route-catalog → seed-maintainer (+ openapi-multilingual if tags).
4. **workers-events** — only if the intake declares events/queues/workers.
5. **seed-maintainer** — reference + bulk/faker rows per the intake.
6. **test-generator** (+ **contract-test-maintainer** / **chaos-test-maintainer** when section 7 marks them) — generate the test layers declared in section 7 (unit, integration, e2e, smoke; contract/chaos if needed); the intake's cases become the acceptance tests.
7. **i18n-message-guard**, **tsdoc-export-guard**, **overview-doc-maintainer**, OpenAPI — i18n + docs.

## 3. Autonomous verify → heal loop

Run the gates; on failure, route long output through `headroom_compress`, diagnose, fix, and re-run — until green. **Definition of done:** `pnpm validate` + the route/domain gates + a live `pnpm verify:base` smoke + **`/pre-merge-review`** clean. Escalate (`AskUserQuestion`) **only** on ambiguity, an irreversible/destructive step, a security trade-off, or repeated no-progress failure.

## 4. Emit the reports bundle

Write `docs/builds/<YYYY-MM-DD>-<feature>/`:

- **build-report.md** — files created, decisions, assumptions, any spec deviations.
- **traceability.md** — each intake item → the code + tests that satisfy it.
- **review.md** — the `/pre-merge-review` output.
- **quality.md** — test/tsdoc/route coverage + lint/type status; security notes (RLS/tenant, idempotency, secrets).

Commit per step so the build is resumable. Do **not** open a PR unless asked — when the slice is green, suggest `/ship`.
