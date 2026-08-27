`src/tests/global/`

# Global regression tests

## Purpose

Static / cross-cutting regressions that apply to the whole codebase: domain dependency-rule scans, worker readiness asserts, audit-emission cardinality checks, and similar guardrails that don't fit a single domain.

Vitest project: `global` (configured in [tooling/vitest/projects.ts](tooling/vitest/projects.ts)).

What this suite covers:

- Domain dependency rules (services: same-domain repository + other domains' services only; no `request-database.context` from workers, etc.).
- Layer boundaries beyond services — controllers/routes never runtime-import repositories, schemas, or database infrastructure; repositories never import services/controllers; dto/validator/serializer stay pure (`layer-boundary.global.test.ts`).
- Worker readiness — every domain that registers a worker has a corresponding heartbeat and DLQ wiring.
- Cross-domain audit surface pinning — exactly the reviewed set of non-audit files imports `@/domains/audit/*`, so an audit trail can neither vanish nor grow silently (`audit-surface-pinning.global.test.ts`).
- Schema / route catalog drift detection.
- Schema ↔ FORCE-RLS parity — every table declared in a `*.schema.ts` appears in `EXPECTED_FORCE_RLS_TABLES` (or a reviewed exemption) and vice versa, catching new-table-without-RLS offline before the DB-bound RLS matrix runs (`schema-rls-parity.global.test.ts`).
- Route rate-limit coverage — every route registration carries a `*_RATE_LIMIT` preset or a reviewed global-limiter-only allowlist entry (`route-rate-limit-coverage.global.test.ts`).
- Serializer response leak guard — no credential-shaped output keys (`password`, `*_hash`, `secret`, `encrypted`) and no whole-row spreads in `*.serializer.ts` (`serializer-response-leak.global.test.ts`).
- Event wiring parity — every `*_EVENT` key has an emitter and an `eventBus.on` handler; event string values are globally unique (`event-wiring-parity.global.test.ts`).
- Import path policy — no parent-relative `../` in `src/` or `tooling/` TypeScript (`import-paths.global.test.ts`).
- RLS database context network isolation — no outbound I/O inside `withPrincipalDatabaseContext` callbacks in domain code.

What it does **not** cover: API behavior (see integration / e2e), worker per-job behavior (see integration).

## Test types

- **AST-driven scans** — Walk `src/` and assert structural rules.
- **Module-import scans** — Forbid certain imports under certain paths.

## How to run

```bash
pnpm test:global   # alias: pnpm test:regression
```

No Postgres / Redis required — this suite is static.

## Fixtures and helpers

None — these tests read source files directly.

## Dependencies

- **None** — runs offline. Suitable for the CI quality slice.

## Failure modes

- **New cross-domain repository or schema import in a service** → `service-cross-domain-boundary.global.test.ts` prints the offending file; refactor through the owning domain's service.
- **New worker file forgets to register its DLQ** → the readiness scan flags it; wire through [src/infrastructure/queue/dlq/dead-letter.ts](src/infrastructure/queue/dlq/dead-letter.ts).
- **Route added without `schema` block** → catalog drift caught by sibling `routes:catalog:check`.
