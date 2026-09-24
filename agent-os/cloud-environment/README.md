# agent-os/cloud-environment — shared cloud agent setup

Single source of truth for **cloud session** bring-up (Cursor Cloud Agents, Claude Code
on the web, and similar remote Linux VMs). Local human setup stays in
[docs/getting-started/setup.md](../../docs/getting-started/setup.md).

Implementation scripts live in [`tooling/setup/agent/`](../../tooling/setup/agent/)
(Node, Docker, bootstrap, healthcheck). This directory holds the **policy** agents and
operators copy into each platform's environment config.

## Layout

| File | Purpose |
| ---- | ------- |
| [`environment.json`](environment.json) | Cursor Cloud Agents — `install`, `start`, optional `terminals` |
| [`install.sh`](install.sh) | Idempotent cached install (tools + deps + MCP default pair; **no** full stack bring-up) |
| [`agents-cloud.md`](agents-cloud.md) | On-demand stack instructions every agent reads via `AGENTS.md` |
| [`skills-and-mcps.md`](skills-and-mcps.md) | Which MCPs, skills, and subagents cloud sessions use |

## How each platform picks it up

| Platform | Config location | What to wire |
| -------- | --------------- | ------------ |
| **Cursor** | [`.cursor/environment.json`](../../.cursor/environment.json) → symlink here | `install` runs `install.sh`; optional `start` / `terminals` from `environment.json` |
| **Cursor dashboard** | Cloud Agents → Environment → Install script | Paste contents of `install.sh`, or `bash agent-os/cloud-environment/install.sh` |
| **Claude Code on the web** | Environment → Setup script field | Same `install.sh` lines (see [claude-code-web-environment.md](../../docs/integrations/claude-code-web-environment.md)) |
| **All agents** | [`AGENTS.md`](../../AGENTS.md) → [`agents-cloud.md`](agents-cloud.md) | On-demand `bootstrap.sh` when DB/API/workers are needed |

> **Do not** put full [`bootstrap.sh`](../../tooling/setup/agent/bootstrap.sh) in the
> cached `install` step — a Docker failure there marks the whole environment as failed.
> Run bootstrap **on demand** (see `agents-cloud.md`). `bootstrap.sh` now auto-retries
> with restricted VFS + the cloud-agent compose override when standard compose fails.

## Network allowlist (cloud)

Minimum Custom allowlist entry beyond defaults:

- `nodejs.org` — Node 24 install (`install-node.sh`)

For Docker image pulls without the GCR mirror script, also add
`production.cloudfront.docker.com`. Prefer
[`install-docker-images.sh`](../../tooling/setup/agent/install-docker-images.sh) in
`install.sh` (already included).

## MCP, skills, and subagents

**Full reference:** [`skills-and-mcps.md`](skills-and-mcps.md)

`install.sh` installs the **default MCP pair** and scaffolds [`.mcp.json`](../../.mcp.json):

| Server | Command | Installed by |
| ------ | ------- | ------------ |
| `codegraph` | `codegraph serve --mcp` | `install-codegraph.sh` |
| `headroom` | `headroom mcp serve` | `install-headroom.sh` + `pnpm mcp:setup:default` |

On-demand MCPs (`dashboards`, `core-be:api`, hosted integrations): `pnpm mcp:setup <name>`.
Project skills (43): start at [`be-skill-index`](../../agent-os/skills/be-skill-index/SKILL.md).

## Related

- [cursor-cloud-agent-environment.md](../../docs/integrations/cursor-cloud-agent-environment.md) — image + GitHub prerequisites
- [claude-code-web-environment.md](../../docs/integrations/claude-code-web-environment.md) — tiers, env vars, full bootstrap option
- [Cursor Cloud Agent setup](https://cursor.com/docs/cloud-agent/setup) — platform docs for `environment.json`
