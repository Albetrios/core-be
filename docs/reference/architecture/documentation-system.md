# Documentation system (core-be)

How agents and contributors keep **skills**, **CLAUDE.md**, **hand-written docs in `docs/`**, and **in-source documentation** aligned. Skills orchestrate; docs own the narrative; TSDoc and `<folder>.overview.md` anchor documentation to the code it describes.

---

## Two parallel systems

```mermaid
flowchart TB
  subgraph contributor [Contributor / agent makes a change]
    code[Edit src/]
    docs[Edit docs/]
  end
  subgraph layered [In-source docs - lives in src/]
    sysNarr[src/{OVERVIEW,PATTERNS,FLOWS,POLICIES}.md]
    overview[src/<folder>/<folder>.overview.md]
    tsdoc[TSDoc on every public export]
    schema[Fastify route schema]
  end
  subgraph handDocs [Hand-written docs - lives in docs/]
    index[docs/README.md]
    refs[docs/reference/, docs/process/, docs/deployment/]
  end
  code --> layered
  docs --> handDocs
  layered --> tsdocGate[pnpm tsdoc:check]
  schema --> openapi[docs:check / OpenAPI]
  handDocs --> linkCheck[pnpm docs:lint, docs:links:check]
```

| System | What it covers | Lives in | Owner skills | Hard gate |
| --- | --- | --- | --- | --- |
| **In-source docs** | Code-anchored: every public export's TSDoc, every Fastify route schema, every folder's hand-written `<folder>.overview.md`, system narrative files | TSDoc inside `*.ts`; `**/<folder>.overview.md`; `src/{OVERVIEW,PATTERNS,FLOWS,POLICIES}.md` | be-tsdoc-export-guard, be-route-schema-doc-guard, be-overview-doc-maintainer, be-system-narrative-maintainer | `pnpm tsdoc:check`, `pnpm docs:check` (OpenAPI drift) |
| **Hand-written docs** | Narrative guides — setup, runbooks, deployment, integrations, architecture overviews | `docs/**/*.md` | be-docs-maintainer | `pnpm docs:lint`, `pnpm docs:links:check` |

The two systems are independent and never overwrite each other.

---

## In-source docs — four layers, no auto-generated aggregator

There is intentionally **no auto-generated `DOCS.md`** layer. The previous `tooling/feature-docs/` system was retired in favour of a smaller surface where each artifact has a single source of truth:

| Layer | File(s) | Source of truth | Skill |
| --- | --- | --- | --- |
| **System narratives** (cross-cutting) | `src/OVERVIEW.md`, `src/PATTERNS.md`, `src/FLOWS.md`, `src/POLICIES.md` | Hand-written | be-system-narrative-maintainer |
| **Per-folder overviews** (hand-written narrative) | `src/<folder>/<folder>.overview.md` (~58 files at meaningful boundaries — domains, sub-domains, nested sub-domains, infra subsystems, test suites) | Hand-written | be-overview-doc-maintainer |
| **Symbol-level TSDoc** (per-export documentation) | every `export <kind> <name>` declaration in `*.ts`; IDE hover, TypeDoc, and `tsdoc:check` all read this | Hand-written, in-source | be-tsdoc-export-guard |
| **Fastify route schema** (route documentation) | `schema: { summary, description, tags }` on every route registration → drives `docs/openapi/openapi.json` → Postman + API hub | Inline Zod schema | be-route-schema-doc-guard |

### File-header rule (per-folder <folder>.overview.md)

Line 1 must be the bare backticked relative path:

```markdown
`src/domains/billing/sub-domains/subscription/`

# Subscription

## Purpose
...
```

Required sections vary by template (domain, sub-domain, infra/shared/scripts, test suite); see the **be-overview-doc-maintainer** skill for the full template details.

### TSDoc rule (every public export)

```ts
/**
 * <one-line summary describing what this export does>
 *
 * @remarks
 * Algorithm:
 * 1. <step>
 *
 * Failure modes:
 * - <error class> → <observable behaviour>.
 *
 * Side effects:
 * - <DB writes, event emissions, cache invalidations>.
 */
export class FooService { ... }
```

A summary is required on every public export. `@remarks` is required on **service-like** files (`*.service.ts`, `*.worker.ts`, `*.processor.ts`) and **policy-like** files (`*.policy.ts`). It is optional elsewhere.

### Fastify route schema rule

```ts
app.get(
  '/api/v1/audit/logs',
  {
    schema: {
      summary: 'List audit logs',
      description: 'Returns paginated audit log entries for the current organization.',
      tags: ['Audit'],
      querystring: AuditListQueryDto,
      response: { 200: AuditListResponseDto },
    },
    preHandler: [requireOrganizationPermission('audit:read')],
  },
  controller.list,
);
```

The `schema` block is the **single source of truth** for OpenAPI generation. There is no parallel `routeMetadataMap` side-table and no per-directory route catalog file — Postman and the API documentation hub consume the OpenAPI export directly.

---

## TSDoc coverage gate

`pnpm tsdoc:check` walks `src/**/*.ts`, identifies public exports, and reports two classes of missing documentation:

| Token | What it flags | Fix by |
| --- | --- | --- |
| `MISSING_DESCRIPTION` | A public export has no TSDoc summary | be-tsdoc-export-guard |
| `MISSING_REMARKS` | A service-like / policy-like export has no `@remarks` block | be-tsdoc-export-guard |

The gate is **budget-driven**, not absolute. Counts are compared to [`tooling/tsdoc-coverage/budget.json`](../../../tooling/tsdoc-coverage/budget.json) and may **decrease** but never **increase**. PRs that lower counts run `pnpm tsdoc:check --refresh-budget` and commit the new lower budget. The eventual target is `MISSING_DESCRIPTION = 0` and `MISSING_REMARKS = 0`; the budget exists only because we are starting from a partially-documented codebase.

The gate runs in pre-commit (step 4d), `ci:local`, and `ci:quality`.

```bash
pnpm tsdoc:check                    # enforce budget
pnpm tsdoc:check --report           # also list every (file, symbol) pair
pnpm tsdoc:check --refresh-budget   # lock in current (lower) counts
```

---

## Hand-written docs (the long-standing system)

Hand-written guides live in `docs/` topic subfolders; the index is `docs/README.md`. The owner is **be-docs-maintainer**.

### Agent workflow for hand-written docs

```mermaid
flowchart LR
  intake[Requirement intake] --> readDocs[Read canonical docs]
  readDocs --> index[Consult be-skill-index]
  index --> skills[Run skills in order]
  skills --> code[Implement in src/]
  code --> contentSync[Content-sync owned docs]
  contentSync --> structural[Structural be-docs-maintainer if paths moved]
```

1. **Intake** — [`docs/getting-started/requirement-intake.md`](../../getting-started/requirement-intake.md): pick requirement type and fill details.
2. **Read canonical docs** — use the **Reference docs (read first)** list for that type (below and in intake).
3. **Consult** — [`.cursor/skills/be-skill-index/SKILL.md`](../../../.cursor/skills/be-skill-index/SKILL.md): triggers and command order.
4. **Implement** — follow skills (checklists, `pnpm` commands); do not duplicate long prose from docs inside skills.
5. **Content-sync** — if behavior or conventions changed, update the **canonical doc** for that topic (this page's ownership table). Skip duplicating the same text in CLAUDE or skills unless a **non-negotiable** changed.
6. **Structural** — if a doc file was renamed/moved, run **be-docs-maintainer**. If only `src/` paths moved, run **be-structure-maintainer** + docs content-sync.

**Generated artifacts** (`docs/routes.txt`, `docs/openapi/`, `docs/postman-collection.json`) are never hand-edited; regenerate via `pnpm routes:catalog` / `pnpm docs:generate`.

---

## Documentation ownership map

| Topic | Canonical doc | Primary skill(s) | Update content when |
| ----- | ------------- | ---------------- | ------------------- |
| Sub-domains / layout | [sub-domains-layout.md](./sub-domains-layout.md) | be-domain-generator, be-structure-maintainer | New domain resource kind, import rules, test placement |
| Layers / request flow | [project-structure-guide.md](./project-structure-guide.md) | be-structure-maintainer | Layer matrix, file suffixes, infra/shared layout |
| Scripts (`src/scripts/`) | [scripts-layout.md](./scripts-layout.md) | be-structure-maintainer | Category folders, new script placement, `validate:scripts-layout` |
| Public API / routes | [domains-and-public-api-design.md](./domains-and-public-api-design.md) | be-route-catalog, be-route-schema-doc-guard, be-domain-generator | Route registration pattern, response shape, access control |
| API docs hub (OpenAPI, Scalar, Postman) | [api-documentation.md](../api/api-documentation.md) | be-route-schema-doc-guard, be-openapi-multilingual | Reference UI, validate/upload commands, hosted registry |
| Events / BullMQ | [workers-and-events.md](../runtime/workers-and-events.md) | be-workers-events | Event names, queues, registration paths, DLQ |
| HTTP / Vitest testing | [testing-conventions.md](../testing/testing-conventions.md) | be-test-generator | Pyramid, layout, naming suffixes, inject patterns |
| Manual API smoke | [api-testing.md](../../getting-started/api-testing.md) | be-test-generator | Post-seed manual checklist |
| i18n | [internationalization.md](../runtime/internationalization.md) | be-i18n-message-guard | Key format, locale files |
| CSRF / sessions | [csrf-and-session-cookies.md](../security/csrf-and-session-cookies.md) | be-production-hardening-guard | Cookie model, Origin checks |
| Data lifecycle | [data-lifecycle-deletion.md](../data/data-lifecycle-deletion.md) | be-sql-design-guard, be-db-migration-maintainer | Soft-delete, retention, immutable ledgers |
| API versioning | [api-versioning.md](../api/api-versioning.md) | be-route-schema-doc-guard | Version prefix, API-Version header |
| Chaos testing | [chaos-testing.md](../reliability/chaos-testing.md) | be-chaos-test-maintainer | Toxiproxy setup, scenarios |
| Contract tests | [contract-tests.md](../testing/contract-tests.md) | be-contract-test-maintainer | Stripe/Resend/S3 fixtures |
| Load testing | [load-testing.md](../testing/load-testing.md) | be-structure-maintainer | k6 scenarios, npm scripts |
| Env / credentials | [integrations/credentials-and-env.md](../../integrations/credentials-and-env.md) | be-env-schema-add | User-facing env documentation |
| Doc index / links | [docs/README.md](../../README.md) | be-docs-maintainer | New/renamed/moved hand-written doc |
| New requirements | [requirement-intake.md](../../getting-started/requirement-intake.md) | be-skill-index | New requirement types or skill order |
| **Documentation system (this page)** | [documentation-system.md](./documentation-system.md) | be-docs-maintainer, be-system-narrative-maintainer | Ownership map, in-source layers, gates |

**CLAUDE.md** holds non-negotiables and command cheat sheets only; link to the rows above for detail.

---

## Code change → documentation (quick reference)

Full skill triggers live in [be-skill-index](../../../.cursor/skills/be-skill-index/SKILL.md).

| Code change | In-source skill | Hand-written doc to update (if convention/behaviour changed) |
| ----------- | --------------- | --------------------------------------------------------------- |
| New / changed `*.routes.ts` | be-route-schema-doc-guard | domains-and-public-api-design.md, api-versioning.md |
| New `events/`, `queues/`, `workers/` | be-tsdoc-export-guard, be-overview-doc-maintainer | workers-and-events.md |
| New / changed `*.schema.ts`, migrations (retention/soft-delete) | be-tsdoc-export-guard | data-lifecycle-deletion.md |
| Test layout, `*.unit.test.ts` tiers | be-overview-doc-maintainer (`src/tests/<suite>/<suite>.overview.md`) | testing-conventions.md |
| `env.config.ts` (user-facing) | be-tsdoc-export-guard | integrations/credentials-and-env.md |
| Auth/session middleware | be-tsdoc-export-guard | csrf-and-session-cookies.md |
| New domain or sub-domain folder | be-overview-doc-maintainer + be-system-narrative-maintainer (Domains table) | sub-domains-layout.md, project-structure-guide.md |
| New cross-cutting pattern (idempotency, transactional outbox, etc.) | be-system-narrative-maintainer (`src/PATTERNS.md`) | (link from relevant reference doc) |
| New end-to-end flow (request lifecycle, webhook ingest, etc.) | be-system-narrative-maintainer (`src/FLOWS.md`) | (link from relevant reference doc) |
| New policy constant under `src/shared/constants/` | be-tsdoc-export-guard + be-system-narrative-maintainer (`src/POLICIES.md`) | (link from relevant reference doc) |

---

## Skill file template

Every **domain/architecture** skill under `.cursor/skills/<name>/SKILL.md` follows roughly:

```markdown
---
name: ...
description: ...
---

# Title

## Purpose
(1–2 paragraphs)

## When to use
(triggers)

## Workflow / Checklist
- [ ] Read canonical docs above
- [ ] … implementation steps …
- [ ] pnpm commands
- [ ] Content-sync doc if convention changed

## Related skills
- Cross-links to skills that should run before/after.
```

The four **in-source documentation skills** (be-system-narrative-maintainer, be-overview-doc-maintainer, be-route-schema-doc-guard, be-tsdoc-export-guard) follow this same shape.

**Gate skills** (be-before-commit-guard, be-ci-investigation, be-pr-babysit, be-lint-warnings-handler) stay command-centric; they do not need a full ownership block.

---

## be-docs-maintainer modes

| Mode | Trigger | Actions |
| ---- | ------- | ------- |
| **Structural** | Added / renamed / moved file under `docs/` | Update `docs/README.md`, deployment index, cross-links, Mermaid on flow docs |
| **Content-sync** | `src/` change per ownership map; paths unchanged | Update section in canonical doc; avoid copying into skills/CLAUDE |

If only behavior changed, prefer **content-sync** only. Update CLAUDE only when a non-negotiable invariant changed.

**Scope boundary:** be-docs-maintainer covers only `docs/**/*.md`. In-source docs under `src/` (TSDoc + `<folder>.overview.md` + system narrative files) are owned by the in-source skills above.

---

## Link and lint validation

Three independent gates:

| Gate | Command | Scope |
| --- | --- | --- |
| Hand-written link drift | `pnpm docs:links:check` | `docs/**`, skills, rules, key repo markdown |
| Markdown formatting | `pnpm docs:lint` | All `.md` (per `.markdownlint-cli2.jsonc`) |
| TSDoc coverage | `pnpm tsdoc:check` | Every public export under `src/**/*.ts` |
| OpenAPI drift | `pnpm docs:check` | Generated `docs/openapi/openapi.json` |

All run in `ci:quality` and `ci:local`; pre-commit runs the same.

```bash
pnpm docs:links:check     # hand-written link drift
pnpm docs:lint            # markdown formatting
pnpm tsdoc:check          # TSDoc coverage budget
pnpm docs:check           # OpenAPI / Postman drift
```

---

## Why the auto-generated DOCS.md aggregator was retired

A previous iteration of this system included an auto-generated `DOCS.md` per directory (~124 files), built by `tooling/feature-docs/`. It was deliberately removed because:

1. **TSDoc was already the source of truth.** `DOCS.md` was just a re-render — IDE hover, TypeDoc, and AI agents reading the source all read the TSDoc directly.
2. **Routes had triple coverage.** `schema.description` → OpenAPI → Postman / API hub; the route tables in `DOCS.md` were a fourth re-render of the same content.
3. **The generator was ~1500 lines of code** that had to stay healthy forever, plus a baseline file, plus a markdown-lint gate for its own output.
4. **`<folder>.overview.md` already covered the only thing TSDoc could not** — design decisions, failure modes, tuning knobs, external dependencies — and survived intact.

If a browsable HTML API site is ever required, [TypeDoc](https://typedoc.org/) can render one from TSDoc on demand without committing intermediate artifacts.

---

## Related

- [AGENTS.md](../../../AGENTS.md) — PR gate, parallel agents, in-source docs callout
- [CLAUDE.md](../../../CLAUDE.md) — architecture invariants, in-source docs subsection
- [CONTRIBUTING.md](../../../CONTRIBUTING.md) — human contributor workflow
- [`src/OVERVIEW.md`](../../../src/OVERVIEW.md) — top of the system narrative tree
- [`tooling/tsdoc-coverage/README.md`](../../../tooling/tsdoc-coverage/README.md) — gate internals
