# Claude Code on the web — environment for core-be

Use this when you run **[Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)** (cloud sessions at claude.ai/code) against this repository. It describes the environment you must create so `pnpm install`, the validation gates, and the test suite work — and what to add when you need a database or live third-party calls.

The Cursor equivalent is [cursor-cloud-agent-environment.md](cursor-cloud-agent-environment.md); local human setup is [SETUP.md](../../SETUP.md).

---

## TL;DR — the environment to create

For day-to-day work (lint, typecheck, unit tests, and the `agent-os` / route / tsdoc gates):

| Lever | Value |
| ----- | ----- |
| **Network access** | **Custom** — keep the default allowlist and add `nodejs.org` |
| **Setup script** | `bash tooling/setup/agent/install-node.sh` |
| **Environment variables** | none required |
| **Runtime services** | none — static checks and unit tests need no database |

That makes `pnpm install` → `pnpm validate` / `pnpm test:unit` / `pnpm agent-os:check` / `pnpm routes:catalog:check` / `pnpm tsdoc:check` work. Add a database and env vars only for DB-bound tests (Tier 2), and third-party hosts only for live integrations (Tier 3).

---

## Why a setup script is required

The cloud image ships **Node 20, 21, and 22**; core-be's `engines` require **Node 24+** (pinned in [`.nvmrc`](../../.nvmrc)). Node 24 is **not** pre-installed, so a setup script must install it. [`tooling/setup/agent/install-node.sh`](../../tooling/setup/agent/install-node.sh) installs the `.nvmrc` version into `/opt/node24` — the same layout the image uses and exactly where the [`session-start.sh`](../../agent-os/hooks/session-start.sh) hook looks — so the hook switches `PATH` to it and runs `pnpm install` automatically. The repo's Node version is unchanged.

---

## The four levers

Set these in the environment settings dialog (web UI). See the [configuration docs](https://code.claude.com/docs/en/claude-code-on-the-web#the-cloud-environment).

1. **Network access** — `None` / `Trusted` / `Full` / `Custom`. `Trusted` (the default) allows a built-in allowlist of registries, GitHub, and cloud SDKs.
2. **Environment variables** — `.env` format, one `KEY=value` per line, **no quotes**. Stored in the environment config and visible to anyone who can edit it (there is no secrets store), so use **test** keys, never live secrets.
3. **Setup script** — Bash, runs **as root before the session launches**, and its filesystem result is **cached** (it re-runs only when you change the script or the allowlist, or after roughly seven days). Use it for runtimes and system packages.
4. **Runtime services** — PostgreSQL and Redis are **pre-installed but not running**, and Docker is available. Setup-script *processes* do not persist (only the filesystem), so start services **per session**.

---

## Network access

The default **Trusted** allowlist already covers what `pnpm install` and image pulls need:

| Need | Host(s) already in Trusted |
| ---- | -------------------------- |
| pnpm / npm | `registry.npmjs.org` |
| Git / GitHub | `github.com` (plus the GitHub proxy) |
| S3 (uploads) | `*.amazonaws.com` |
| Docker images (Postgres / Redis) | `registry-1.docker.io` (Docker Hub) |
| Google OAuth | `accounts.google.com` |

Add the rest via **Custom** (tick "Also include default list of common package managers"):

- `nodejs.org` — **always**, for the Node 24 download in the setup script. Without it the install is blocked.
- Tier 3 only (live calls; contract tests mock these, so usually unnecessary): `api.stripe.com`, `api.resend.com`, `sentry.io` / `*.ingest.sentry.io`.

> **Do not use `None`** — it blocks `pnpm install` entirely.

---

## Setup script

**Canonical (shared with Cursor):** paste the contents of
[`agent-os/cloud-environment/install.sh`](../../agent-os/cloud-environment/install.sh),
or run:

```bash
bash agent-os/cloud-environment/install.sh
```

That script wraps the same helpers below. For a hand-maintained list:

```bash
bash tooling/setup/agent/install-node.sh
bash tooling/setup/agent/install-gh.sh              # optional: GitHub CLI (in-session GitHub fallback)
bash tooling/setup/agent/install-docker-images.sh   # optional: Docker Hub mirror + pre-pull compose images
bash tooling/setup/agent/install-codegraph.sh       # default MCP pair: CodeGraph CLI + semantic index
bash tooling/setup/agent/install-headroom.sh        # default MCP pair: Headroom CLI — context-compression MCP (headroom_compress)
bash tooling/setup/agent/install-gitleaks.sh        # optional: gitleaks (pre-commit secret scan)
```

On the first session the cached Node 24 is already on disk, [`session-start.sh`](../../agent-os/hooks/session-start.sh) switches `PATH` to `/opt/node24`, and runs `pnpm install`. Do **not** start Postgres / Redis here — setup-script processes do not persist; start them per session (below).

**GitHub CLI (optional).** [`install-gh.sh`](../../tooling/setup/agent/install-gh.sh) adds `gh` as an in-session fallback for reading Actions logs, checking CI, and merging (the GitHub MCP tools already cover this). It belongs in the cached **setup script**, not `session-start.sh` — a per-session `apt install` would not cache and would slow every startup. Set `GH_TOKEN` in the environment's **Variables** (least-privilege: `contents` + `pull_requests` + `actions:read`; env vars are not a secrets store). The script first installs the **github.com release binary** (reachable on the default Trusted allowlist, so no extra allowlist entry is normally needed); its `cli.github.com` apt-repo path is only a last resort.

**gitleaks (recommended if you commit).** The pre-commit guard's "Staged secrets scan" step shells out to `gitleaks protect --staged …` and hard-errors when the binary is missing, so a cloud session cannot commit until gitleaks is installed. The cloud image does not ship it. [`install-gitleaks.sh`](../../tooling/setup/agent/install-gitleaks.sh) installs the **github.com release binary** (reachable on the default Trusted allowlist), pinned to the same version as the CI `security-secrets` job. If that download fails it falls back to `go install` — which must use gitleaks's **legacy self-declared module path** `github.com/zricethezav/gitleaks/v8` (the current `github.com/gitleaks` repo path fails Go's module-path check).

---

## Environment variables

**Tests need none.** [`src/tests/setup.ts`](../../src/tests/setup.ts) bakes in test RS256 JWT PEMs and sets every other value (`??=` or hard override), and [`src/tests/global-setup.ts`](../../src/tests/global-setup.ts) forces `DATABASE_URL` to the local Docker DB and runs `pnpm db:migrate`. So the full suite runs with **only Postgres + Redis up** — no env vars and no key generation, exactly like local.

You only need env vars to run the **app itself** (`pnpm dev` / `pnpm dev:worker`). Mirror the `api-smoke` service in [`docker-compose.yml`](../../docker-compose.yml) (`pnpm compose:up` publishes Postgres on `localhost:5432` and Redis on `localhost:6379`):

```text
NODE_ENV=development
DATABASE_URL=postgresql://core:core@localhost:5432/core
DATABASE_MIGRATION_URL=postgresql://core:core@localhost:5432/core
REDIS_URL=redis://localhost:6379
DATABASE_SSL_ENABLED=false
METRICS_ENABLED=false
SECRETS_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000
```

- `DATABASE_MIGRATION_URL` must be the **direct (non-pooler)** host — `pnpm db:migrate` rejects a pooler URL.
- `DATABASE_SSL_ENABLED=false` is for plaintext local Docker only.
- `METRICS_ENABLED=false` avoids requiring `METRICS_SCRAPE_TOKEN` at boot.
- **JWT keys** (`JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`) are multi-line RS256 PEMs the env-var field handles poorly; generate them in a SessionStart hook (writing to a gitignored `.env.local`) or via `pnpm setup:local --only-env`. Tests do not need this — they use the baked-in keys in [`src/tests/setup.ts`](../../src/tests/setup.ts).

The full variable surface and how to obtain real values: [`.env.example`](../../.env.example) and [credentials-and-env.md](credentials-and-env.md).

---

## Runtime services (Postgres, Redis)

Use the repo's compose scripts — the **same ones you run locally** — so the cloud session matches local exactly. Run per session (or from a SessionStart hook):

```bash
pnpm compose:up      # start Postgres + Redis (same as local)
pnpm compose:wait    # block until Postgres accepts connections
pnpm db:migrate
pnpm db:seed         # or pnpm db:seed:full
```

`pnpm compose:up` also starts the local SonarQube container unless you set `SONAR=0`; a cloud session rarely needs it, so `SONAR=0 pnpm compose:up` brings up just Postgres + Redis. Stop everything with `pnpm compose:down`.

> **Docker image pulls in the cloud.** Docker Hub serves image *blobs* from a CDN (`production.cloudfront.docker.com`) that is **not** on the default allowlist, so a bare `pnpm compose:up` fails with `403 Forbidden` while pulling `postgres:<v>-alpine` / `redis:<v>-alpine` (AWS ECR Public has the same `*.cloudfront.net` problem). Run [`install-docker-images.sh`](../../tooling/setup/agent/install-docker-images.sh) in the Setup script: it points the Docker daemon at Google's Docker Hub pull-through mirror (`https://mirror.gcr.io` — reachable on the default allowlist, byte-identical images / same digests) and pre-pulls the compose images, so `pnpm compose:up` runs the **same** pinned images you use locally with no compose changes. Alternatively add `production.cloudfront.docker.com` to the Custom network allowlist to pull straight from Docker Hub. Note Postgres **17+** is required by `pnpm db:migrate`, so the cloud image's native Postgres 16 is not a substitute.

**Restricted cloud Docker.** [`bootstrap.sh`](../../tooling/setup/agent/bootstrap.sh) calls the shared [`ensure-docker-daemon.sh`](../../tooling/setup/agent/ensure-docker-daemon.sh) helper before compose. If a cloud-agent container denies Docker bridge/NAT setup or overlay layer extraction, the helper falls back to restricted networking, then `vfs` storage when needed, and `bootstrap.sh` uses the shared [`docker-compose.cloud-agent.yml`](../../tooling/setup/agent/docker-compose.cloud-agent.yml) host-network override for Postgres + Redis.

---

### One-command bring-up + verify

To run the whole in-session flow at once — tool installs (gh, Docker CLI/Compose when missing, Docker daemon start, Docker mirror, CodeGraph, Headroom, gitleaks), `compose:up`, `db:migrate`, `db:seed`, then an app healthcheck — use the orchestrator, which logs a ✓/✗ status after each step:

```bash
bash tooling/setup/agent/bootstrap.sh        # KEEP_APP=1 to leave `pnpm dev` running afterwards
```

It leaves Postgres + Redis up and starts the app only transiently for the check. To verify health on its own (after the app is up), run [`healthcheck.sh`](../../tooling/setup/agent/healthcheck.sh): it polls `GET /livez` then `GET /readyz` and exits non-zero unless Postgres + Redis + BullMQ are all reachable. Neither belongs in the Setup-script *field* (that runs before any app is listening).

## Tiers — what to enable for which goal

| Tier | Goal | Network | Services | Env vars |
| ---- | ---- | ------- | -------- | -------- |
| **1** | Lint, typecheck, unit tests, the gates | Custom: defaults + `nodejs.org` | none | none |
| **2** | Full test suite (e2e / integration), migrations, seed | same | `pnpm compose:up` (Postgres + Redis) | none — tests self-provision |
| **3** | Run the app (`pnpm dev` / `pnpm dev:worker`) | same | `pnpm compose:up` | the boot block above |
| **4** | Live Stripe / Resend / S3 / Sentry calls | + their API hosts | + Postgres / Redis | + real test keys |

---

## Session startup vs on-demand

Startup stays **light** so a session is ready fast: the setup script (Node 24, cached) plus `session-start.sh`, which runs `pnpm install` and a single `pnpm agent-os:check` readiness gate. Nothing else is bootstrapped.

Everything else runs **on demand, driven by your prompt** — `pnpm compose:up` for the database, `pnpm db:migrate` / `pnpm db:seed`, the test suite, or `pnpm dev` — started only when a task needs it.

## How to tell a session is provisioned

The `session-start.sh` banner (top of every session) leads with **`environment provisioned: yes|no`** — `yes` means the cached toolchain the Setup script builds (Node ≥ `.nvmrc` + installed deps) is live in this session. The same line reports `Node`, `deps`, `gh`, `codegraph`, `gitleaks`, `agent-os`, and `docker` status. Manual cross-checks: `node -v` (expect 24.x), `gh --version`, `ls /opt/node24`.

A `no` means the Setup script has not built this cache yet (e.g. Node still 22, deps missing) — configure the Setup script + `nodejs.org` allowlist, then start a fresh session.

## Setup flow

```mermaid
flowchart TD
  create["Create environment"] --> net["Network: Custom + nodejs.org"]
  net --> setupScript["Setup script: install-node.sh (cached)"]
  setupScript --> hook["session-start.sh: /opt/node24, pnpm install, agent-os:check"]
  hook --> ready["Session ready (light startup)"]
  ready -->|"your prompt drives work"| prompt["Work starts per prompt"]
  prompt --> staticChecks["validate / test:unit / agent-os:check"]
  prompt --> services["pnpm compose:up + pnpm compose:wait"]
  services --> migrate["pnpm db:migrate + pnpm db:seed"]
  migrate --> dbWork["e2e / DB tests, or pnpm dev"]
```

---

## core-be gotchas

- **Node 24 is not pre-installed** — the setup script is mandatory; without it the session is stuck on Node 22 and `engines` rejects it.
- **`nodejs.org` is not in the default Trusted allowlist** — the most common miss.
- **Husky activates after `pnpm install`** (its `prepare` step), so a properly configured session gets the **same** pre-commit / pre-push gates as local — including the pre-commit SonarQube gate (mandatory, no bypass), which needs Docker for `pnpm sonar:up` (the gate auto-starts it on first use). Before deps install (e.g. a session still on Node 22) Husky is inactive and commits skip the hooks.
- **Branch creates are allowed; branch deletes are not.** The git proxy accepts a push to any branch name, but refuses every form of branch delete. Rename the session's `claude/*` branch **before the first push** — see [be-git-branch-naming.mdc](../../agent-os/rules/be-git-branch-naming.mdc).

---

## GitHub prerequisites (and why creating a PR prompts)

A cloud session can touch GitHub only after the platform is **authorized** on this repo, and opening a PR is a deliberate, gated step — not something the agent does unprompted.

- **One-time authorization (the connect-GitHub prompt).** Install / authorize the platform's GitHub App or connector on `nikunjmavani/core-be` with **least-privilege** scopes — `contents` (read/write the working branch), `pull_requests` (open/update PRs), and `actions: read` (CI status / logs). Without it the session cannot fetch, push, or open a PR.
- **The branch name is yours to choose — but only before the first push.** The cloud git proxy does **not** pin a session to its assigned `claude/<slug>` branch: a push to any conventional `<type>/<slug>` name succeeds. What it does refuse is **deletes** — `git push --delete`, `git push :ref`, and `DELETE /git/refs/…` all fail (the last with `403 Write access to this GitHub API path is not permitted through this proxy`). A `claude/*` branch that has already been pushed therefore cannot be removed from inside the session; it disappears only when the PR squash-merges. Rename with `git branch -m <type>/<slug>` **before** pushing, per [be-git-branch-naming.mdc](../../agent-os/rules/be-git-branch-naming.mdc), which keeps `claude/*` allowlisted as the fallback.
- **"Create PR" asks first — by design.** Opening a pull request is an outward-facing action, so the agent won't do it unsolicited; it confirms first (Claude Code web uses the scoped **GitHub MCP** tools rather than `gh`). Ask explicitly when you want the PR opened, then drive CI to green per [trunk-based-workflow.md](../process/trunk-based-workflow.md).

---

## MCP servers

In Claude Code on the web the live MCP server set is loaded by the **platform at session start** from your account / environment MCP settings — **not** the repo's [`.mcp.json`](../../.mcp.example.json). Installing a server's CLI in-session (e.g. CodeGraph) does not make its tools appear until a fresh session starts with that server configured in the web UI.

The repo splits the MCP set into two tiers:

- **Default auto-start pair — `codegraph` + `headroom`** (committed in [`.mcp.default.json`](../../.mcp.default.json)). Two zero-config, agent-only servers (local CLIs, no token): CodeGraph (semantic code index) and Headroom (context compression). `pnpm setup:local` and the cloud bootstrap ([`install-codegraph.sh`](../../tooling/setup/agent/install-codegraph.sh) + [`install-headroom.sh`](../../tooling/setup/agent/install-headroom.sh)) install their CLIs and declare both in `.mcp.json`, so a session is useful with no setup.
- **On-demand set — everything else.** [`.mcp.example.json`](../../.mcp.example.json) (mirrored at [`agent-os/mcp/mcp.example.json`](../../agent-os/mcp/mcp.example.json)) lists the full set: `context7`, `core-be:api`, `neon`, `sentry`, `railway`, `aws`, `stripe`, `semgrep`, `sonarqube`, `redis`, `postman`, `resend`, `codegraph`, `headroom`. Most need a provider token (put them in the environment **Variables**) and several need `uvx` / `docker`, so connect only the subset a task needs. Scaffold them into a local `.mcp.json` with **`pnpm mcp:setup`** — all, or a subset by name (`pnpm mcp:setup stripe sentry`); `pnpm mcp:setup:default` for just the pair, `pnpm mcp:setup --list` to see status. The full catalog (per-server runtime + token) is in [agentic-third-party-tooling.md](agentic-third-party-tooling.md#setting-up-mcp-locally-pnpm-mcpsetup).

### Configure the web environment (one-time, in the web UI)

Because the platform — not `.mcp.json` — drives a cloud session's MCP, set these in the environment's MCP settings:

1. **Add the default pair so they auto-connect every session:** `codegraph` (command `codegraph serve --mcp`) and `headroom` (command `headroom mcp serve`). Their CLIs are installed by the Setup script above.
2. **Add any on-demand server a task needs** from `.mcp.example.json`, supplying its token via the environment **Variables**.
3. **Do not add `Composio`, `Descript`, or `Slack`.** They are intentionally not part of this project's tooling — use `gh` / the GitHub MCP for GitHub, and keep any personal-account servers at the user level, separate from the repo. (See [agentic-third-party-tooling.md](agentic-third-party-tooling.md).)

## Related documentation

- [cursor-cloud-agent-environment.md](cursor-cloud-agent-environment.md) — the Cursor cloud-agent equivalent (`Dockerfile.agent`).
- [SETUP.md](../../SETUP.md) — local human setup, env vars, testing, CI/CD.
- [agent-os/hooks/README.md](../../agent-os/hooks/README.md) — the SessionStart hook and the other Claude Code hooks in this repo.
- [Claude Code on the web docs](https://code.claude.com/docs/en/claude-code-on-the-web) — setup scripts, network policies, environment caching.
