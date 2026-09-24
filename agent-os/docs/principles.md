# Engineering principles and project identity (core-be)

> **Canonical source** for Claude Code and Codex. Cursor auto-injects
> `agent-os/rules/engineering-principles.mdc` and `agent-os/rules/project-identity.mdc`
> via `alwaysApply: true`. When you update this file, mirror the changes
> to those two rule files so Cursor stays in sync.

---

## Engineering principles

### Role and goals

Write production-grade, maintainable, scalable code. Preserve simplicity; avoid overengineering. Optimize for readability, developer experience, and long-term maintainability. Follow existing project conventions unless there is a strong reason to improve them.

### Before writing code

1. Read **[CLAUDE.md](../../CLAUDE.md)** for architecture, domains, and dependency rules.
2. For new requirements, use **[requirement-intake](../../docs/getting-started/requirement-intake.md)** and consult **[skill-index](../skills/skill-index/SKILL.md)** first.
3. **Reuse before you create.** Before adding a helper, wrapper, env var, constant or pattern, search for the one that already does the job and use it. Create something new only when nothing existing fits.
   - **Close but not quite right?** Improve the existing one instead of forking a parallel version — or, if new is genuinely the better design, say why in the PR description. Either way, do it **in the same PR**: never leave old and new side by side behind a "consolidate later".
   - **Recognize the miss:** a new `TEST_*_URL` beside the existing `DATABASE_OPERATOR_URL`, or a hand-rolled second pool that re-implements `getMaintenanceDatabase()`, is the parallel-version smell. PR #1193 did both, then folded them back into the existing pieces.
4. Do not introduce duplicate abstractions.
5. **Product slug, image names, branch/env mapping:** follow **[project-identity.mdc](../rules/project-identity.mdc)** — manifest `tooling/setup/setup.config.json` and imports from `project-identity.constants.ts`; do not hardcode `core-be` (or manifest-derived names) in `src/`, workflows, or tooling.

### Code quality

- Prefer simple solutions over clever ones.
- Keep functions small and single-purpose; use descriptive naming.
- Avoid magic numbers and hardcoded values; extract constants when reused. Place each constant at the **lowest scope that covers its use sites** — one file → a local `const`; one sub-domain/domain → a co-located `*.constants.ts`; cross-cutting primitives only → `src/shared/constants/`. See **[core-be-src-architecture.mdc](../rules/core-be-src-architecture.mdc)**.
- Add comments only when logic is non-obvious.
- Remove dead code, unused imports, `console.log`, and commented-out code.
- Use `logger` from `@/shared/utils/infrastructure/logger.util.js` in application code.
- Avoid unnecessary dependencies.
- **Object parameters only** for any function/method with 2+ inputs, except in `*.repository.ts` / `*.repository.unit.test.ts` and framework-mandated callbacks (Fastify handlers, BullMQ processors, DI constructors, test/Zod callbacks). See **[object-params.mdc](../rules/object-params.mdc)**.

### Architecture (brief)

- **Import paths**: `@/` in `src/`, `@tooling/` in tooling; same-folder `./` only — no parent-relative `../`. See **[import-paths.mdc](../rules/import-paths.mdc)**.
- **Controllers** coordinate only — thin handlers, no DB queries.
- **Services** express intent — business logic, validators, events; they may declare a transaction boundary via `withTransaction` for atomicity, but issue no raw SQL and manage no DB connection (repositories own the SQL; enforced by `no-direct-db-in-services.global.test.ts`).
- **Repositories** own DB access (Drizzle).
- **Services** express intent; they use **same-domain repositories** and other domains' **services** for cross-domain reads/writes — never another domain's repository or schema.
- **Postgres** is the only source of truth; workers are pull-based (BullMQ).

For layout, layers, routes, events, and Drizzle conventions, follow **[core-be-src-architecture.mdc](../rules/core-be-src-architecture.mdc)** when editing `src/**/*.ts`. For naming, follow **[full-names-only.mdc](../rules/full-names-only.mdc)**.

### Type safety

- Use strict TypeScript; avoid `any` unless absolutely necessary.
- Prefer inferred types when readable.
- Validate external and request data with Zod DTOs and function-based validators (`.safeParse()` + `ValidationError`).

### Backend and API

- Validate all inputs; never trust client-side data.
- Use typed errors from `@/shared/errors`; user-facing messages via i18n translation keys (see **[i18n-message-guard](../skills/i18n-message-guard/SKILL.md)**).
- Use `withTransaction` where multiple writes must succeed or fail together.
- Avoid N+1 queries; keep repository access efficient.
- Workers and scripts must pass organization identifiers explicitly in queries — do not rely on RLS session context.
- Handle edge cases and failure states; use `successResponse` / `paginatedResponse` for HTTP responses.

### Security

- Never expose secrets or API keys in code or commits.
- Sanitize and validate user input; follow OWASP-minded practices.
- Enforce permissions via existing auth middleware, tenant context, and `authorization.service` — do not skip authorization checks.

### Performance

- Optimize only where measurement or review shows benefit.
- Reduce unnecessary API calls and duplicate work.
- Use existing Redis caching patterns (e.g. permission cache) where appropriate.

### Context efficiency (Headroom)

Route large, low-signal text — long command/CI/test output, logs, whole-file reads, RAG/search chunks — through the **Headroom MCP** (`headroom_compress`) before loading it into context; pull originals with `headroom_retrieve` when exact bytes are needed. Skip compression for small outputs or content applied verbatim (diffs, code to edit, migration SQL, secrets). Shared by all AI agents — see **[headroom-context-compression.mdc](../rules/headroom-context-compression.mdc)**.

### Git and refactoring

- Make minimal, focused changes; do not rewrite unrelated code.
- Preserve backward compatibility unless instructed otherwise.
- When refactoring: improve clarity, reduce duplication, preserve behavior, keep diffs clean.
- Do not create git commits unless the user explicitly asks.

### Documentation and sync skills

- Update docs, types, OpenAPI locale keys, and examples when behavior changes.
- Do not add unsolicited markdown files or README sections.
- **After each task**, consult **[skill-index](../skills/skill-index/SKILL.md)** once and run only the skills listed for the files you changed (routes → route-catalog, env → env-schema-add, hand-written docs → docs-maintainer, etc.). Do not invoke overlapping skills separately.

### Output behavior

When implementing:

1. Analyze the current implementation.
2. Explain problems briefly and clearly.
3. Suggest the cleanest solution.
4. Implement the solution.
5. Mention tradeoffs when relevant.

Keep responses concise and engineering-focused.

### PR review mode

When reviewing code, check for: bugs, architecture violations, performance issues, security risks, unnecessary complexity, bad naming, dead code, and DX issues. Suggest cleaner alternatives; prefer maintainability over cleverness.

### Anti-patterns

Avoid: massive files, deeply nested conditionals, duplicated logic, tight coupling, hidden side effects, pass-through facade layers between controller and service, raw user-facing strings (use i18n keys), DB access in controllers, processors in `infrastructure/queue/` (belong in domains).

### Dependency policy

Before adding a dependency: check whether existing code or platform APIs solve the problem; prefer lightweight libraries; justify large or new packages. Follow **[dependency-security](../skills/dependency-security/SKILL.md)** when changing `package.json`.

### Testing

Write testable, deterministic, loosely coupled code.

- Domain tests: `src/domains/<domain>/__tests__/` — see **[testing-conventions.mdc](../rules/testing-conventions.mdc)**.
- Fix Biome lint issues in touched files per **[code-smells-and-best-practices](../skills/code-smells-and-best-practices/SKILL.md)**; full `pnpm validate` is enforced by pre-commit and CI (do not duplicate on every small edit).
- Run `pnpm test` (or targeted tests) before considering work complete.

### Final rule

Always leave the codebase cleaner, simpler, safer, and easier to maintain than before your change.

---

## Project identity (names and branches)

**Manifest (edit this):** `tooling/setup/setup.config.json` — `project.name`, `project.displayName`, `project.artifacts`, `environments[]`, optional `git`.

**Generated (do not hand-edit):**

- `src/shared/constants/project-identity.constants.ts` — runtime TypeScript
- `.github/project-identity.env`, `docker-bake.hcl`
- Workflow `# BEGIN GENERATED project-identity` job `env:` blocks and branch/deploy patches

**After manifest changes:** `pnpm tool:generate-project-identity` (pre-commit runs this when `setup.config.json` is staged). **Drift gate:** `pnpm tool:generate-project-identity:check` (in `pnpm ci:quality`).

### Use these imports in `src/` and `tooling/` (not string literals)

Import from `@/shared/constants/project-identity.constants.js`:

| Need | Constant | Avoid |
| ---- | -------- | ----- |
| Product slug (issuer, Neon name, MCP scheme) | `PROJECT_SLUG` | `'core-be'` |
| Human-facing product name (emails, copy) | `PROJECT_DISPLAY_NAME` | `'core-be'` |
| OpenAPI default `info.title` (emitter fallback) | `PROJECT_OPENAPI_TITLE` | `'core-be API'` |
| JWT `iss` | `JWT_ISSUER` | slug literal |
| TOTP authenticator issuer | `TOTP_ISSUER` | slug literal |
| WebAuthn RP name when env unset | `WEBAUTHN_RP_NAME_DEFAULT` | slug literal |
| MCP URI scheme | `MCP_URI_SCHEME` | `'core-be'` |
| MCP resource URIs | `MCP_OPENAPI_RESOURCE_URI`, `MCP_ROUTES_RESOURCE_URI` | `core-be://…` |
| OTEL service names | `OTEL_SERVICE_NAME_API`, `OTEL_SERVICE_NAME_WORKER` | `core-be-api`, `core-be-worker` |
| OTEL tracer scope | `OTEL_TRACER_NAME` | slug literal |
| Local Docker tags (scripts/docs only) | `DOCKER_LOCAL_API_TAG`, `DOCKER_LOCAL_WORKER_TAG` | `core-be`, `core-be-worker` |
| GHCR image repo names (reference) | `GHCR_API_IMAGE_NAME`, `GHCR_WORKER_IMAGE_NAME` | `core-be-api`, … |
| Protected git branches | `PROTECTED_GIT_BRANCHES` | `['main']` |
| Default / prod / non-prod branch | `GIT_DEFAULT_BRANCH`, `GIT_PRODUCTION_BRANCH`, `GIT_NON_PRODUCTION_BRANCH` | `'main'` (single trunk) |
| Branch → hosted environment | `BRANCH_TO_ENVIRONMENT_MAP` | `main` → `production` |

**Tests:** assert against the same constants (e.g. `JWT_ISSUER`), not copied literals.

### GitHub Actions and Docker

- **Never** hardcode image names (`core-be-api`, `core-be-worker`, `core-be:ci`) or protected branch lists in workflow YAML.
- Use generated job `env`: `API_IMAGE`, `WORKER_IMAGE`, `DOCKER_LOCAL_API_TAG`, `GHCR_CACHE_SCOPE_*`, `PROTECTED_BRANCHES_JSON`.
- To change branches or environments, edit the manifest and run `pnpm tool:generate-project-identity` — do not edit deploy `case` blocks by hand.

### Shell scripts and OpenAPI locales

- Scripts: source `.github/project-identity.env` when the slug is needed (see `tooling/ci/restore-drill-neon.sh`).
- `src/shared/locales/{en,es}/openapi.json` — `info.title` is updated by codegen; keep in sync via generate, do not set a one-off product name by hand.

### OK to keep literal (exceptions)

- Repository folder name, `package.json` `"name"`, historical CHANGELOG / review docs
- External URLs or IDs already provisioned under a fixed slug in a third-party console
- Generic prose that is not the product name (e.g. "backend API" in a description)

### Related

- Deployment: `docs/deployment/runbooks/add-new-environment.md`, `docs/deployment/ci-cd/cicd-and-deployment.md`
- Skill: `agent-os/skills/env-schema-add/SKILL.md` (hosted envs + manifest)
- Scoped sync rule: **project-identity-sync.mdc** when editing manifest, workflows, or codegen
