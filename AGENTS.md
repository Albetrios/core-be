# Guidance for coding agents (core-be)

Before changing this repository:

1. Follow **[.cursor/rules/be-engineering-principles.mdc](.cursor/rules/be-engineering-principles.mdc)** for general engineering behavior (always applied in Cursor). Product slug, image names, and branch/env mapping: **[.cursor/rules/be-project-identity.mdc](.cursor/rules/be-project-identity.mdc)** (`tooling/setup/setup.config.json` → `project-identity.constants.ts`).
2. Agent-os items this repo owns start with `be-` (see **[CLAUDE.md → Agent-os naming](CLAUDE.md#agent-os-naming)**); upstream skills keep their names.
3. Read **[CLAUDE.md](CLAUDE.md)** for architecture, domain layout, dependency rules, and commands. Import path policy: **[`.cursor/rules/be-import-paths.mdc`](.cursor/rules/be-import-paths.mdc)** (`@/` in `src/`, `@tooling/` in tooling; no `../`).
4. For new domains, routes, workers, or schema work, follow **[docs/getting-started/requirement-intake.md](docs/getting-started/requirement-intake.md)** and consult **[be-skill-index](agent-os/skills/be-skill-index/SKILL.md)** first (45 project skills; Cursor built-ins: **be-cursor-global-skills**) — run only the skills that match your changes (no duplicate invocations).
5. For any change under `src/`, the **in-source documentation system** also applies — see **[docs/reference/architecture/documentation-system.md](docs/reference/architecture/documentation-system.md)**. TSDoc on every public export is canonical (gated by `pnpm tsdoc:check` against [`tooling/tsdoc-coverage/budget.json`](tooling/tsdoc-coverage/budget.json) — counts may decrease but may not increase); hand-written `<folder>.overview.md` files cover folder-level design decisions; `src/{OVERVIEW,PATTERNS,FLOWS,POLICIES}.md` carry the system narrative. There is no auto-generated `DOCS.md` aggregator.
6. Human contributors — see **[CONTRIBUTING.md](CONTRIBUTING.md)** (setup summary, branching, **`SECURITY.md`**, **`CODE_OF_CONDUCT.md`**, **[`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md)**).
7. Before opening a pull request, ensure these pass (pre-commit runs the same sync checks locally):

 ```bash
 pnpm guard:pre-commit   # labeled pre-commit (same as git commit hook)
 pnpm ci:local
 ```

   Same checks individually: `pnpm validate`, `pnpm validate:domain`, `pnpm routes:catalog:check`, `pnpm tsdoc:check`, `pnpm db:migrate:lint`, `pnpm tool:sync-env-example`, `pnpm test`. Static CI quality slice (no tests): `pnpm ci:quality`.

   Optional local integration gate (Docker Postgres + Redis running): `pnpm verify:base` — migrate → seed (minimal + full) → live API smoke → validate. Local stack: `pnpm compose:up` then `pnpm compose:wait`.

## Cloud agent sessions

On **Cursor Cloud Agents** or **Claude Code on the web**, read
**[agent-os/cloud-environment/agents-cloud.md](agent-os/cloud-environment/agents-cloud.md)**
before DB/e2e/app work. Cached install + Cursor `environment.json` live in
**[agent-os/cloud-environment/](agent-os/cloud-environment/)** (symlinked at
[`.cursor/environment.json`](.cursor/environment.json)). **MCPs, skills, and subagents**
for cloud sessions: **[agent-os/cloud-environment/skills-and-mcps.md](agent-os/cloud-environment/skills-and-mcps.md)**.

## Cursor Cloud specific instructions

The startup update script runs `bash agent-os/cloud-environment/install.sh` (Node 24 via
`/opt/node24/bin`, `pnpm install`, Docker CLI, `.env.local` scaffold). Always prefix shells
with `export PATH="/opt/node24/bin:$HOME/.local/bin:$PATH"` — the base image default is Node 22,
which trips the engines gate. Lint/typecheck/unit tests need no services; e2e/`pnpm dev` need
Postgres + Redis (see [agents-cloud.md](agent-os/cloud-environment/agents-cloud.md)).

Bringing up Docker on this VM (Firecracker kernel + Docker 29) needs caveats the committed
`tooling/setup/agent` scripts do not yet fully cover; `bash tooling/setup/agent/bootstrap.sh`
can hang/fail at the compose step. To bring up the stack manually:

- **Storage:** the kernel cannot mount overlay2 for running containers (image pulls work, container
  create fails with `mount ... overlay ... invalid argument`). Install `fuse-overlayfs` and set
  `/etc/docker/daemon.json` to `{"storage-driver":"fuse-overlayfs","features":{"containerd-snapshotter":false}}`.
  Disabling the containerd snapshotter is mandatory on Docker 29 — otherwise `--storage-driver` is ignored.
- **Daemon:** start with restricted networking (`sudo dockerd --iptables=false --ip-masq=false
  --ip-forward=false --bridge=none`); nftables NAT is unsupported, so bridge networking fails. After
  start, `sudo chmod a+rw /var/run/docker.sock`.
- **Compose:** the Ubuntu `docker-compose-v2` package (`+ds1`) has an old schema; install the official
  plugin binary to `~/.docker/cli-plugins/docker-compose`. Use host networking for Postgres + Redis
  (so `localhost:5432` / `:6379` from `.env.local` resolve). The committed
  `tooling/setup/agent/docker-compose.cloud-agent.yml` uses `cgroupns_mode`, which Compose rejects —
  use `cgroup: host` instead. Postgres also needs `mem_limit: 0`: the VM cgroupv2 root is
  `domain threaded`, so containers requesting the memory controller fail with `cannot enter cgroupv2
  ... threaded mode`. Bring up with an override that sets `network_mode: host`, `cgroup: host`,
  `mem_limit: 0` (postgres), and `ports: !reset []`, then `pnpm db:migrate && pnpm db:seed`.
- **Worker:** `pnpm dev:worker` fails the connection-budget guard with default `DATABASE_POOL_MAX=20`
  (monolithic worker demand is ~47). Start it as
  `DATABASE_POOL_MAX=60 POSTGRES_MAX_CONNECTIONS=500 pnpm dev:worker` (`.env.local` loads with
  `override=false` under `NODE_ENV=development`, so shell env wins). The compose Postgres allows 500
  connections. `pnpm dev` (API) runs fine with defaults.

Health: `GET /livez`, `GET /readyz` on `:3000`. Sentry/OpenTelemetry "duplicate registration" lines
at API boot are benign (invalid placeholder DSN) and do not block startup.

## Additional resources

- **Cursor cloud agent** — Linux environments with full dev dependencies (separate from production image): **[docs/integrations/cursor-cloud-agent-environment.md](docs/integrations/cursor-cloud-agent-environment.md)**
- **Claude Code on the web** — network access, setup script, env vars, Postgres/Redis: **[docs/integrations/claude-code-web-environment.md](docs/integrations/claude-code-web-environment.md)**
- **Codex local setup** — keep using the project-local `.codex/` hooks/MCP config and `~/.codex/prompts` command symlinks described below.
- **Codex Cloud setup archive** — reference-only notes for removed cloud-session setup attempts: **[docs/integrations/codex-cloud-agent-setup-archive.md](docs/integrations/codex-cloud-agent-setup-archive.md)**
- **Agent map** — skills, rules, subagents, MCP: **[docs/integrations/cursor-agent-system.md](docs/integrations/cursor-agent-system.md)**

## Custom subagents

Project-defined subagents in [`agent-os/agents/`](agent-os/agents/) run in isolation
(read-only) for heavy diagnostics.

**Full catalog + use-when:** [agent-os/docs/agents-catalog.md](agent-os/docs/agents-catalog.md)
**Platform invocation (Cursor / Claude Code / Codex):** [agent-os/docs/platform-access.md](agent-os/docs/platform-access.md)
**Skill trigger map:** [agent-os/docs/skill-triggers.md](agent-os/docs/skill-triggers.md) — file pattern → which skill to invoke.

To add a subagent, use global **create-subagent**
(see [be-cursor-global-skills](agent-os/skills/be-cursor-global-skills/SKILL.md)) and name it `be-<name>`:
file `agent-os/agents/be-<name>.md`, frontmatter `name: be-<name>` (see CLAUDE.md → Agent-os naming).

## Custom commands

Reusable slash commands live in [`agent-os/commands/`](agent-os/commands/) (single
source of truth). Claude Code reads them via `.claude/commands`, Cursor via
`.cursor/commands`; for Codex, symlink them into `~/.codex/prompts/` (see
[agent-os/docs/commands.md](agent-os/docs/commands.md)). Available: `/be-validate`,
`/be-ci-local`, `/be-new-domain`, `/be-routes-sync`.

## Guardrails

Executable guardrails enforce the repo's safety rules per platform
(see [`agent-os/hooks/README.md`](agent-os/hooks/README.md)):

- **Claude Code** — `SessionStart` + `PreToolUse` hooks in [`agent-os/hooks/`](agent-os/hooks/)
  (wired in `.claude/settings.json`): verify env + install deps on the web; block
  destructive shell and secret writes; warn on protected paths and cross-domain imports.
- **Cursor** — `beforeShellExecution` hook (`.cursor/hooks.json`) blocks destructive
  shell; file-level rules are advisory in [`.cursor/rules/be-ai-guardrails.mdc`](.cursor/rules/be-ai-guardrails.mdc).
- **Codex** — enforce via generated project-local [`.codex/hooks.json`](.codex/hooks.json)
  (from `agent-os/hooks/hooks.json`: startup context, prompt skill routing, Bash
  guardrails, stop reminders), [`.codex/config.toml`](.codex/config.toml)
  (symlink to generated default MCP pair: CodeGraph + Headroom), sandbox +
  approvals in `~/.codex/config.toml` (`sandbox_mode = "workspace-write"`,
  `approval_policy = "on-request"`), plus the policy below.

Policy (all agents): never write secrets to source (`.env*` except `.env.example`);
no `rm -rf` / `git push --force`; treat `migrations/*.sql` and billing ledgers as
immutable (add-only); cross-domain access goes through services, not repositories/schemas.
