# Cloud agent instructions (core-be)

Read this on **remote / cloud** sessions (Cursor Cloud Agents, Claude Code on the web)
before tasks that need Postgres, Redis, migrations, seeds, or a live API.

Canonical config: [`agent-os/cloud-environment/`](./) (`install.sh`, `environment.json`).

**Skills, MCPs, subagents:** [`skills-and-mcps.md`](skills-and-mcps.md) — default pair
(`codegraph`, `headroom`) is installed and written to `.mcp.json` by `install.sh`; on-demand
MCPs and the full skill catalog are listed there.

## When to run bring-up

| Task needs | Run bring-up? |
| ---------- | ------------- |
| Lint, typecheck, unit tests, `pnpm agent-os:check` | No |
| E2E, integration, `pnpm test`, migrations | Yes |
| `pnpm dev`, `pnpm dev:worker`, `/readyz`, API smoke | Yes |

## One-command bring-up

```bash
export PATH="/opt/node24/bin:$HOME/.local/bin:$PATH"
bash tooling/setup/agent/bootstrap.sh
```

Leaves Postgres + Redis up; starts the app only for the healthcheck, then stops it.
To keep the API running:

```bash
KEEP_APP=1 bash tooling/setup/agent/bootstrap.sh
```

Or start manually after bootstrap:

```bash
pnpm dev          # API (tmux / background)
pnpm dev:worker   # BullMQ workers
bash tooling/setup/agent/healthcheck.sh
```

## Step-by-step (same as local)

```bash
export PATH="/opt/node24/bin:$HOME/.local/bin:$PATH"
SONAR=0 pnpm compose:up && pnpm compose:wait
pnpm db:migrate && pnpm db:seed
pnpm dev &
bash tooling/setup/agent/healthcheck.sh
```

## Restricted Docker VMs

`bootstrap.sh` retries automatically: if standard `compose:up` fails (overlay mount or
cgroup errors), it switches Docker to **restricted VFS** mode and uses the
[`docker-compose.cloud-agent.yml`](../../tooling/setup/agent/docker-compose.cloud-agent.yml)
override (host network + `cgroupns_mode: host` for Postgres).

Manual fallback:

```bash
FORCE_RESTRICTED_VFS=1 bash tooling/setup/agent/ensure-docker-daemon.sh
docker compose -f docker-compose.yml -f tooling/setup/agent/docker-compose.cloud-agent.yml up -d postgres redis
```

## Health endpoints

- `GET /livez` — process up (200)
- `GET /readyz` — Postgres + Redis + BullMQ (200 or 503)

## MCP default pair

`install.sh` installs `codegraph` and `headroom` to `~/.local/bin` and runs
`pnpm mcp:setup:default` (same as local `pnpm setup:local`). If MCP tools are missing in a
session, confirm platform MCP settings match [`.mcp.default.json`](../../.mcp.default.json)
and start a fresh session. For **be-stack-monitor**, add `dashboards` via
`pnpm mcp:setup dashboards` after `pnpm dashboards:up` — see [`skills-and-mcps.md`](skills-and-mcps.md).
