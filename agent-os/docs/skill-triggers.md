# Skill triggers (core-be)

When you edit a file matching a pattern below, invoke the listed skill(s).
Single source of truth — consult instead of reading all 25 sync rules.
Skills live in [`agent-os/skills/`](../skills/).

<!-- GENERATED:START -->
When you edit a file matching a pattern below, invoke the listed skill(s). Generated from
`agent-os/skills/chains.json` (multi-skill rows) and per-skill `trigger` frontmatter.

| File pattern | Invoke skill(s) | Notes |
| ------------ | --------------- | ----- |
| `src/domains/**/*.routes.ts` | be-api-contract-guard → be-route-schema-doc-guard → be-route-catalog → be-seed-maintainer (+ be-openapi-multilingual) | Adding or changing an API route end-to-end. |
| `src/domains/**/*.schema.ts` | be-schema-generator → be-sql-design-guard → be-db-migration-maintainer → be-rls-tenant-isolation-guard | Adding or changing a Drizzle schema / table end-to-end. |
| `src/domains/**/events/**`, `src/domains/**/queues/**`, `src/domains/**/workers/**` | be-workers-events → be-test-generator → be-tsdoc-export-guard | Adding or changing events, queues, or workers. |
| `src/domains/**/*.container.ts` | be-domain-generator → be-schema-generator → be-db-migration-maintainer → be-workers-events → be-route-schema-doc-guard → be-route-catalog → be-seed-maintainer → be-test-generator → be-tsdoc-export-guard → be-overview-doc-maintainer → be-system-narrative-maintainer | Scaffolding a whole new domain or sub-domain (the full DAG). |
| `.vscode/extensions.json`, `.vscode/settings.json` | be-ide-productivity-guard | Backend-relevant IDE tooling |
| `CLAUDE.md`, `AGENTS.md`, `agent-os/rules/**`, `agent-os/skills/**`, `agent-os/agents/**`, `agent-os/mcp/**`, `.mcp.example.json`, `.mcp.default.json` | be-structure-maintainer | Structure/naming; MCP template mirrors must stay identical (mcp-config test) |
| `biome.json`, `.husky/pre-commit`, `.husky/pre-push` | be-code-quality-guard | Lint/format/pre-commit/pre-push + branch-name policy |
| `docs/**/*.md` | be-docs-maintainer | Hand-written docs — index + cross-links |
| `migrations/*.sql` | be-db-migration-maintainer | Migration files (schema changes go via the schema-change chain) |
| `package.json`, `pnpm-lock.yaml` | be-dependency-security | Zero-vuln dependency updates |
| `src/**/*.overview.md` | be-overview-doc-maintainer | Per-folder overview docs |
| `src/**/*.ts` | be-change-completeness-guard | Finishing any code change — own tests + cross-cutting suites + docs + rules + skills move with it |
| `src/**/*.ts` | be-tsdoc-export-guard | Public export added/renamed — TSDoc summary (+ @remarks on service/worker/policy) |
| `src/OVERVIEW.md`, `src/PATTERNS.md`, `src/FLOWS.md`, `src/POLICIES.md` | be-system-narrative-maintainer | System-level narratives |
| `src/domains/**/*.cache.ts`, `src/infrastructure/cache/redis-tombstone-cache.util.ts` | be-read-cache-guard | Redis read caches — key scope, tombstone invalidation, fail-open, TTL, tests |
| `src/domains/**/*.validator.ts`, `src/domains/**/*.serializer.ts` | be-test-generator | Pure-layer units + domain e2e per the testing pyramid |
| `src/domains/**/seed/**`, `src/scripts/seed/**` | be-seed-maintainer | Keep per-domain seeds aligned with schemas + routes |
| `src/infrastructure/database/contexts/**`, `src/domains/**/*.worker.ts` | be-rls-tenant-isolation-guard | DB context wrappers, workers, and RLS migrations — tenant isolation |
| `src/routes.ts` | be-domain-generator | Check DI wiring / route registration (new domain scaffolds via the new-domain chain) |
| `src/shared/config/env-schema.ts`, `.env.example` | be-env-schema-add | Env var add/rename/remove |
| `src/shared/locales/**/*.json` | be-i18n-message-guard | User-facing copy / translation keys |
| `src/shared/locales/*/openapi.json` | be-openapi-multilingual | Multilingual OpenAPI copy |
| `src/shared/middlewares/core/idempotency.middleware.ts`, `src/infrastructure/payment/stripe.client.ts` | be-idempotency-guard | Idempotency engine + idempotencyRequired writes + Stripe mutations |
| `src/shared/utils/http/list-query.util.ts` | be-api-contract-guard | List endpoints (search/sort/pagination); also route params / public ids / statuses / headers. Status policy: docs/reference/api/response-codes.md |
| `src/tests/chaos/**` | be-chaos-test-maintainer | Toxiproxy fault-injection suite |
| `src/tests/contract/**` | be-contract-test-maintainer | Outbound HTTP contracts (Stripe/Resend/S3) |
<!-- GENERATED:END -->
> The 25 `agent-os/rules/*-sync.mdc` files remain for Cursor's glob auto-attach.
> This table is the human-readable cross-platform equivalent.
>
> Every entry in the "Invoke skill(s)" column is a skill in `agent-os/skills/`.
>
> One sync rule has **no** backing skill and therefore no row above: `be-project-identity-sync`
> (`agent-os/rules/be-project-identity-sync.mdc`) auto-attaches on `tooling/setup/setup.config.json`
> and is command-driven — run `pnpm tool:generate-project-identity` after editing that manifest.
