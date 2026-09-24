# Agentic third-party tooling — CLI vs MCP vs SDK

How core-be talks to third-party services depends on **who the caller is**. CLI, MCP, and
SDK are not competing choices for the same slot — they serve three different consumers.
Pick by consumer, not by preference.

## Decision model (pick by consumer)

| Consumer | Where it lives | Use | Why |
| --- | --- | --- | --- |
| **Application runtime** | `src/**` (API + worker) | **SDK** | In-process, typed, deterministic, no shell-out. Already how we integrate every provider. |
| **CI/CD + scripts** | `.github/workflows/**`, `tooling/**`, `pnpm` scripts | **CLI** | Deterministic, returns exit codes, version-pinnable, auditable, no LLM/tokens/network-to-an-agent. |
| **Interactive AI agent** | Claude Code / Cursor sessions | **MCP** (preferred), else **CLI via shell** | Dynamic tool discovery, structured results, per-session scoped auth. Falls back to the CLI over Bash when no MCP exists. |

### Why MCP does **not** belong in code or CI/CD

An MCP server is a runtime protocol for an **LLM agent** to discover and call tools. In a
pipeline or in application code that is the wrong shape:

- **Non-deterministic** — there is a model in the loop; a gate that must pass/fail reliably
  cannot depend on one.
- **Needs an agent runtime + tokens + network** to reach it. A CLI is a pinned binary.
- **Not auditable/pinnable** like `semgrep==1.x` or a checksum-verified CLI.
- **Slower and flakier** than a direct CLI/SDK call.

So: **from code → SDK. From CI/CD → CLI. For the agent → MCP (CLI as fallback).** Your
instinct is right — for code and CI/CD the CLI (or SDK) is the correct tool, not MCP.

## Per-service mapping

✅ wired into `.mcp.example.json` · — not applicable / no peer server

| Service | Runtime (`src/`) → SDK | CI/CD + scripts → CLI | Interactive agent → MCP |
| --- | --- | --- | --- |
| **Neon / Postgres** | `postgres`, `drizzle-orm` | `drizzle-kit`, `psql`, `neonctl` | ✅ `mcp.neon.tech/mcp` |
| **Redis / BullMQ** | `ioredis`, `bullmq` | `redis-cli` | ✅ `redis/mcp-redis` (inspect queues/DLQ/idempotency/rate-limit keys live) |
| **AWS S3** | `@aws-sdk/client-s3` | `aws` | ✅ `mcp-proxy-for-aws` |
| **Stripe** | `stripe` | `stripe` (`listen` / `trigger` / `fixtures`) | ✅ `mcp.stripe.com` |
| **Resend** | `resend` | — (curl/API) | ✅ `mcp/resend` (Docker) |
| **Sentry** | `@sentry/node` | `sentry-cli` (releases/sourcemaps) | ✅ `mcp.sentry.dev/mcp` (+ Seer root-cause) |
| **GitHub** | Actions / Octokit | `gh` | — `gh` CLI (peer MCP `api.githubcopilot.com/mcp/` exists but is intentionally **not** wired at project level) |
| **Railway** | — | `railway` (`redeploy`) | ✅ `@railway/mcp-server` |
| **SonarQube** | — | `sonar-scanner` (`pnpm sonar:scan`) | ✅ `mcp/sonarqube` (read findings + quality gate) |
| **Semgrep** | — | `semgrep` (`pnpm security:sast`) | ✅ `semgrep-mcp` (scan + structured findings) |
| **Gitleaks** | — | `gitleaks` (`pnpm security:secrets`) | — |
| **Postman** | — | Postman CLI / `newman` (`pnpm docs:upload`) | ✅ `mcp.postman.com/mcp` |
| **Cloudflare Turnstile** | fetch verify | `wrangler` | — no MCP (low value); scope TODO below |
| **Docker** | — | `docker` (`compose`, `buildx bake`) | — gateway only (Docker MCP Toolkit proxies servers, not a peer) |
| **Context7** (lib docs) | — | — | ✅ `@upstash/context7-mcp` |
| **codegraph** (code index) | — | `codegraph` | ✅ `codegraph serve --mcp` |
| **Serena** (semantic code nav) | — | — | ✅ `uvx --from git+https://github.com/oraios/serena serena start-mcp-server` (LSP-backed symbol retrieve/edit — returns symbols, not whole files; token-efficient on a large repo) |
| **ast-grep** (structural search) | — | `ast-grep` CLI | ✅ `uvx --from ast-grep-mcp --package ast-grep-mcp run` (AST pattern search — returns matches, not files) |
| **Headroom** (context compression) | — | — | ✅ `headroom mcp serve` (compress large tool output / logs / files before they reach the model) |
| **dashboards** (local stack status) | — | — | ✅ `node tooling/dev/dashboards/mcp.mjs` (local-only — reads stack health / queue stats / metrics from the dashboards proxy on `:3010`; run `pnpm dashboards:up` first) |

**Stripe is the canonical "all three" case:** the `stripe` SDK runs in the service, the
`stripe` CLI replays/triggers webhooks against the local `stripe-webhook` domain in dev/CI,
and the Stripe MCP lets an agent inspect test-mode objects. They coexist; none replaces another.

> **TODO (future scope):** Turnstile appears in the codebase only as server-side CAPTCHA token
> verification, and there's no agent MCP worth wiring (low value). Bringing **Turnstile / CAPTCHA
> hardening** into proper scope is parked here as a tracked future item — decision 2026-06-15:
> skip the agent MCP now, revisit the broader scope later.

## What the agent already has

The MCP servers in [`.mcp.example.json`](../../.mcp.example.json) (mirrored at
`agent-os/mcp/mcp.example.json`): **context7, core-be:api, neon, sentry, railway, aws,
stripe, semgrep, sonarqube, redis, postman, resend, codegraph, headroom**. These are
*agent-only*; CI/CD and runtime do not use them.

They split into two tiers:

- **Default auto-start pair — `codegraph` + `headroom`** (committed in
  [`.mcp.default.json`](../../.mcp.default.json)). Zero-config, no token (local CLIs);
  declared in `.mcp.json` by `pnpm setup:local`, the session-start hook, and the cloud
  bootstrap so they are available before the first prompt.
- **On-demand set — the other twelve.** Most need a provider token. Scaffold them into
  `.mcp.json` with **`pnpm mcp:setup`** — all at once, or a subset by name
  (`pnpm mcp:setup stripe sentry`); `pnpm mcp:setup:default` for just the pair, and
  `pnpm mcp:setup --list` for status. On Claude Code web the live set is configured in
  the environment MCP settings (web UI), not `.mcp.json` — see
  [claude-code-web-environment.md](claude-code-web-environment.md).

The **GitHub**, **Composio**, **Descript**, and **Slack** MCPs are intentionally **not**
part of this project's config — use `gh` / the GitHub MCP for GitHub, and keep any
personal-account servers at the user level so they stay separate from the repo.

## Setting up MCP locally (`pnpm mcp:setup`)

`.mcp.json` (gitignored) is scaffolded from the committed templates — pick the scope:

| Command | Scaffolds |
| ------- | --------- |
| `pnpm mcp:setup` | the full set (default pair + the 12 on-demand servers) |
| `pnpm mcp:setup <name>…` | only the named servers, e.g. `pnpm mcp:setup stripe sentry redis` |
| `pnpm mcp:setup:default` | only the auto-start pair (codegraph + headroom) |
| `pnpm mcp:setup --list` | every server + whether it is declared (the canonical list) |
| `pnpm mcp:setup --check` | dry run — report what would change, no write |

Merges are **non-destructive**: existing `.mcp.json` entries (with real keys) are kept, and a
server whose token or CLI is missing simply stays disconnected until you fill its `${VAR}` in
`.env.local`. Unknown names are ignored with a hint. On Claude Code web the live set is
configured in the environment MCP settings (web UI), not this file.

### On-demand servers (everything except the default pair)

`pnpm mcp:setup --list` prints the live list; this snapshot shows what each needs to connect:

| Server | Purpose | Runtime | Token / env |
| ------ | ------- | ------- | ----------- |
| `context7` | version-specific backend library docs | `npx` | `CONTEXT7_API_KEY` |
| `core-be:api` | the app's own MCP at `/api/v1/mcp` | local URL | none — needs `pnpm dev` running |
| `neon` | Neon Postgres management | remote URL | OAuth at connect |
| `sentry` | error tracking / Seer root-cause | remote URL | OAuth at connect |
| `railway` | deploy / redeploy | `npx` | Railway login / token |
| `aws` | AWS API access | `uvx` | ambient AWS creds / SSO |
| `stripe` | inspect test-mode Stripe objects | remote URL | OAuth at connect |
| `semgrep` | SAST scan + structured findings | `uvx` | none |
| `sonarqube` | read findings + quality gate | `docker` | `SONARQUBE_TOKEN`, `SONARQUBE_URL` |
| `redis` | inspect Redis | `uvx` | `REDIS_URL` |
| `postman` | Postman workspace / API | remote URL | OAuth or bearer |
| `resend` | send test emails | `docker` | `RESEND_API_KEY` |

Runtime prerequisites: node / `npx` (always present), `uvx` (from `uv`) for `aws` / `semgrep` /
`redis`, and `docker` for `sonarqube` / `resend`.

## Agent MCP server notes (CI/CD keeps the CLIs)

None of these change CI/CD or runtime — Sonar/Semgrep still run as CLI gates, the app still
uses `ioredis` / `resend`. The MCP server only gives the **interactive agent** structured
access (read findings, inspect Redis, send a test email) instead of parsing CLI stdout over
Bash. The non-trivial local invocations:

```jsonc
"semgrep":   { "command": "uvx",    "args": ["semgrep-mcp"] },
"sonarqube": { "command": "docker", "args": ["run", "--init", "--pull=always", "--rm", "-i",
                                              "-e", "SONARQUBE_TOKEN", "-e", "SONARQUBE_URL", "mcp/sonarqube"] },
"redis":     { "command": "uvx",    "args": ["--from", "redis-mcp-server@latest", "redis-mcp-server", "--url", "${REDIS_URL}"] },
"resend":    { "command": "docker", "args": ["run", "-i", "--rm", "-e", "RESEND_API_KEY", "mcp/resend"] }
```

Postman is a plain remote URL (`https://mcp.postman.com/mcp`; OAuth, or `Authorization: Bearer
<key>`). **Docker** is deliberately *not* a peer entry: "Docker MCP" is the **MCP
Toolkit/Gateway** (`docker mcp gateway run`) — an umbrella that proxies other MCP servers, not
a service to operate, so it sits *in front of* this list, not inside it.

**Headroom** is a different category from the service MCPs above: it is an *agent-only context
compression layer*, not a peer to any third-party service (no SDK, no CI/CD CLI). It compresses
large tool output, logs, files, and RAG chunks before they reach the model (`headroom_compress`
/ `headroom_retrieve` / `headroom_stats`). Local install: `pip install "headroom-ai[mcp]"` then
`headroom mcp install` (the declarative entry is `{ "command": "headroom", "args": ["mcp",
"serve"] }`). All agents should use it — see
[`agent-os/rules/be-headroom-context-compression.mdc`](../../agent-os/rules/be-headroom-context-compression.mdc).

> Endpoints and package names move fast — verify against each vendor's current docs before
> relying on a config. Sources: [Semgrep](https://github.com/semgrep/mcp),
> [SonarQube](https://github.com/SonarSource/sonarqube-mcp-server),
> [Redis](https://github.com/redis/mcp-redis),
> [Resend](https://github.com/resend/mcp-send-email),
> [Postman](https://learning.postman.com/docs/developer/postman-api/postman-mcp-server/set-up-postman-mcp-server),
> [Docker MCP](https://docs.docker.com/ai/mcp-catalog-and-toolkit/toolkit/).
