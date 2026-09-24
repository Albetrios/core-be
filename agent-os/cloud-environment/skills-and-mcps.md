# Cloud environment — skills, MCPs, and subagents

What coding agents get in a **Cursor Cloud Agent** or **Claude Code on the web** session
after the cached install (`install.sh`) and optional on-demand bring-up (`bootstrap.sh`).

Canonical install: [`install.sh`](install.sh) · Stack bring-up: [`agents-cloud.md`](agents-cloud.md)

---

## MCP servers

### Installed and auto-declared by `install.sh`

These are the **default auto-start pair** (zero token, local stdio). `install.sh` installs
the CLIs and runs `pnpm mcp:setup:default` to write the gitignored [`.mcp.json`](../../.mcp.json)
from [`.mcp.default.json`](../../.mcp.default.json).

| Server | CLI install | `.mcp.json` command | Purpose |
| ------ | ----------- | ------------------- | ------- |
| **codegraph** | `install-codegraph.sh` | `codegraph serve --mcp` | Semantic code index — query the repo graph instead of grep loops |
| **headroom** | `install-headroom.sh` | `headroom mcp serve` | Context compression — `headroom_compress` / `headroom_retrieve` / `headroom_stats` for large tool output |

**PATH:** CLIs land in `~/.local/bin`; install sets `PATH="/opt/node24/bin:$HOME/.local/bin:$PATH"`.

**Platform note:** Claude Code on the web loads MCP from the **environment MCP settings** in
the web UI as well as repo `.mcp.json`. Cursor Cloud Agents read `.mcp.json` when present.
Configure the same `codegraph` + `headroom` commands in the platform MCP panel if tools do
not appear after a fresh session.

### Often available from the platform (not in `install.sh`)

| Server | Source | Purpose |
| ------ | ------ | ------- |
| **Context7** | Cursor / Claude platform MCP | Version-specific library docs (`resolve-library-id`, `query-docs`) |

### On-demand — add when the task needs them

Scaffold into `.mcp.json` with `pnpm mcp:setup <name>` (see
[`docs/integrations/agentic-third-party-tooling.md`](../../docs/integrations/agentic-third-party-tooling.md)).

| Server | When to add | Prerequisite |
| ------ | ----------- | ------------ |
| **dashboards** | Stack monitoring (`be-stack-monitor` subagent), load-test observability | `pnpm mcp:setup dashboards` then `pnpm dashboards:up` or `pnpm dashboards:proxy` |
| **core-be:api** | Call live API tools from the agent | API running with `ENABLE_MCP_SERVER=true` — `pnpm mcp:setup core-be:api` |
| **context7** | Up-to-date Fastify/Drizzle/BullMQ docs (if not platform-provided) | `CONTEXT7_API_KEY` — `pnpm mcp:setup context7` |
| **serena** | Semantic code navigation on a large repo — go-to-def / find-refs / symbol bodies; returns **symbols, not files** (token-efficient) | `uvx` — `pnpm mcp:setup serena` |
| **ast-grep** | Structural (AST) code search — returns **matches, not** text hits or whole files | `uvx` + `ast-grep` CLI — `pnpm mcp:setup ast-grep` |
| **neon**, **sentry**, **railway**, **aws**, **stripe**, **semgrep**, **sonarqube**, **redis**, **postman**, **resend** | Hosted integration / ops tasks | Provider token + `pnpm mcp:setup <name>` |

Full template: [`.mcp.example.json`](../../.mcp.example.json). List status: `pnpm mcp:setup:list`.

**Serena onboarding (first use).** `serena` is LSP-backed semantic code retrieval — prefer it (and
`codegraph`) over whole-file reads to keep context small (see
[`agent-os/rules/be-token-efficient-navigation.mdc`](../../agent-os/rules/be-token-efficient-navigation.mdc)).
After `pnpm mcp:setup serena`, on first use call the server's **`activate_project`** on this repo so it
indexes the codebase; then use `find_symbol` / `find_referencing_symbols` / `get_symbols_overview`
instead of reading files to answer "where / who / what". It complements `codegraph` (graph queries) and
`ast-grep` (structural pattern matches).

**Intentionally not in this project:** `github`, `composio`, `descript`, `slack` MCPs.

---

## Project skills (43)

All project skills live under [`agent-os/skills/`](../../agent-os/skills/). **Consult
[`be-skill-index`](../../agent-os/skills/be-skill-index/SKILL.md) first** — it maps file patterns
to which skill(s) to run (no duplicate invocations).

| Category | Skills | When in cloud |
| -------- | ------ | ------------- |
| **Meta / routing** | `be-skill-index`, `be-change-completeness-guard`, `be-auto-implement`, `be-delegate-search` | Every code change; `be-auto-implement` drives a whole requirement, `be-delegate-search` keeps context small |
| **Routes & API** | `be-api-contract-guard`, `be-route-schema-doc-guard`, `be-route-catalog`, `be-openapi-multilingual` | `*.routes.ts`, controllers, serializers |
| **Domains & schema** | `be-domain-generator`, `be-schema-generator`, `be-sql-design-guard`, `be-db-migration-maintainer` | New domains, `migrations/*.sql`, Drizzle schema |
| **Workers & events** | `be-workers-events` | Queues, workers, event handlers |
| **Seeds & tests** | `be-seed-maintainer`, `be-test-generator`, `be-contract-test-maintainer`, `be-chaos-test-maintainer` | `seed/`, `__tests__/` |
| **Docs & narrative** | `be-docs-maintainer`, `be-overview-doc-maintainer`, `be-system-narrative-maintainer`, `be-tsdoc-export-guard` | `docs/**/*.md`, `src/**/*.overview.md`, public exports |
| **Quality & CI** | `be-code-quality-guard`, `be-before-commit-guard`, `be-dependency-security`, `be-ci-investigation`, `be-pr-babysit` | Pre-commit, `package.json`, CI failures |
| **Infra & setup** | `be-env-schema-add`, `be-production-hardening-guard`, `be-path-to-production-gate` | `tooling/setup/**`, env schema, deploy readiness |
| **Security & tenancy** | `be-rls-tenant-isolation-guard`, `be-idempotency-guard` | RLS, tenant middleware, idempotency |
| **Cursor built-ins (reference)** | `be-cursor-global-skills` | Editing `agent-os/skills`, rules, agents, hooks |

Trigger map (file pattern → skill): [`agent-os/docs/skill-triggers.md`](../../agent-os/docs/skill-triggers.md).

**Cloud-only workflows (no file trigger):** run `bootstrap.sh` instructions from
[`agents-cloud.md`](agents-cloud.md); for load tests see
[`docs/reference/testing/load-testing.md`](../../docs/reference/testing/load-testing.md).

---

## Custom subagents (10)

Read-only agents in [`agent-os/agents/`](../../agent-os/agents/). Catalog:
[`agent-os/docs/agents-catalog.md`](../../agent-os/docs/agents-catalog.md).

| Subagent | Typical cloud use |
| -------- | ----------------- |
| **be-stack-monitor** | Health verdict after `pnpm dashboards:up` — needs **dashboards** MCP or proxy on `:3010` |
| **be-verifier** | Confirm implementation passes `pnpm validate` / tests |
| **be-ci-investigator** | Diagnose failing GitHub Actions on a PR |
| **be-dependency-auditor** | `pnpm audit` report and fix plan |
| **be-production-reviewer** / **be-production-hardening-reviewer** | Pre-deploy readiness |
| **be-sql-design-reviewer** | Drizzle schema / migration design |
| **be-tsdoc-coverage-reviewer** | `pnpm tsdoc:check` gaps |
| **be-docs-auditor** | `docs/` index and cross-links |
| **be-changelog-reviewer** | `CHANGELOG-dev.md` vs branch changes |
| **security-review** / **bugbot** | Review local diffs on request |

Invocation: [`agent-os/docs/platform-access.md`](../../agent-os/docs/platform-access.md).

---

## Rules and hooks (always on)

| Layer | Location | Cloud behavior |
| ----- | -------- | -------------- |
| **Always-applied rules** | `agent-os/rules/be-engineering-principles.mdc`, `be-project-identity.mdc`, `be-change-completeness.mdc` | Cursor auto-attach |
| **Architecture / API** | `CLAUDE.md`, `agent-os/skills/be-api-contract-guard/SKILL.md` | Read before `src/` changes |
| **Import paths** | `agent-os/rules/be-import-paths.mdc` | `@/` in `src/`, `@tooling/` in tooling |
| **Shell guardrails** | `.cursor/hooks.json` | Blocks destructive shell in Cursor cloud |
| **Pre-commit parity** | `pnpm guard:pre-commit` / `pnpm ci:local` | Same gates as local before PR |

---

## Quick reference

```bash
# Cached install (every VM) — tools, deps, .mcp.json default pair, .env.local scaffold
bash agent-os/cloud-environment/install.sh

# On-demand stack (Postgres, Redis, migrate, seed, healthcheck)
bash tooling/setup/agent/bootstrap.sh

# Optional MCP: stack dashboards (be-stack-monitor)
pnpm mcp:setup dashboards && pnpm dashboards:up

# List all MCP template servers + .mcp.json status
pnpm mcp:setup:list
```
