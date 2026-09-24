# Cursor cloud agent development environment (core-be)

Use this when you run **Cursor cloud agents** (or similar automation) against this repository and need a Linux environment with **full dependencies** (including devDependencies), **Git**, and **SSH client** for typical agent workflows.

**Canonical cloud config (all platforms):** [`agent-os/cloud-environment/`](../../agent-os/cloud-environment/) — `install.sh`, `environment.json`, [`agents-cloud.md`](../../agent-os/cloud-environment/agents-cloud.md), and **[`skills-and-mcps.md`](../../agent-os/cloud-environment/skills-and-mcps.md)** (MCPs + skills catalog for cloud sessions). Cursor reads [`.cursor/environment.json`](../../.cursor/environment.json) (symlink).

---

## Which Dockerfile to use

| File                                         | Purpose                                                                                                                                                                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`Dockerfile`](../../Dockerfile)             | **Production** image: multi-stage build, compiled `dist/`, production-only `pnpm install --prod`. Use for deployment, not for running the full test suite or agents that need dev tooling.                                       |
| [`Dockerfile.agent`](../../Dockerfile.agent) | **Agent / development** image: Node 24 on Debian slim, installs all dependencies from the lockfile, copies the full repository. Use as the base for cloud agent environments when agents need to lint, typecheck, or run Vitest. |

---

## Building the agent image locally

From the repository root:

```bash
docker build -f Dockerfile.agent -t core-be-agent .
```

The build context is the full repo. The committed [`.dockerignore`](../../.dockerignore) excludes `node_modules/`, `dist/`, host `docs/`, `.env*`, and test/lint configs from the **build context** — not from the final image. The agent Dockerfile runs `pnpm install` then `COPY . .`, so agents get source and can run `pnpm docs:generate` / `pnpm routes:catalog` inside the container even when host `docs/` is absent from context.

---

## Multi-repository environments

Cursor supports **multi-repo** development environments so one agent session can mount several repositories (for example backend and frontend). See the [Cursor 3.4 changelog (May 13, 2026)](https://cursor.com/changelog/05-13-26) and [Cloud agent setup](https://cursor.com/docs/cloud-agent/setup) for configuration as code, versioning, and Governance.

---

## Private package registries and build secrets

If `pnpm install` must reach a **private npm registry**, configure **build secrets** in your agent environment Dockerfile or host platform so credentials are available only at image build time and are not baked into image layers or the running agent environment. Follow your registry provider’s and Cursor’s documentation for secret mounting; do not commit tokens or `.npmrc` secrets to this repository.

---

## Runtime services (Postgres, Redis)

This image does **not** start PostgreSQL or Redis. For tests that need a database, either:

- Point `DATABASE_URL` and `REDIS_URL` at services started by your agent platform or compose, or
- Follow [getting-started/setup.md](../getting-started/setup.md) for local `docker compose` and `.env`.

---

## GitHub prerequisites (and why creating a PR prompts)

A cloud session can touch GitHub only after the platform is **authorized** on this repo, and opening a PR is a deliberate, gated step — not something the agent does unprompted.

- **One-time authorization (the connect-GitHub prompt).** Install / authorize the platform's GitHub App or connector on `nikunjmavani/core-be` with **least-privilege** scopes — `contents` (read/write the working branch), `pull_requests` (open/update PRs), and `actions: read` (CI status / logs). Without it the session cannot fetch, push, or open a PR.
- **Pushes are pinned to the session branch.** The cloud git proxy restricts a web session to pushing only its assigned working branch (`claude/<slug>` on Claude Code web). Repo hooks run *inside* the session and cannot rename it — `claude/*` is allowlisted by [be-git-branch-naming.mdc](../../agent-os/rules/be-git-branch-naming.mdc) by design. To land work under a `feature/` / `fix/` name, rename at the PR / merge layer.
- **"Create PR" asks first — by design.** Opening a pull request is an outward-facing action, so the agent won't do it unsolicited; it confirms first. Ask explicitly when you want the PR opened, then drive CI to green per [trunk-based-workflow.md](../process/trunk-based-workflow.md).

---

## Related documentation

- [claude-code-web-environment.md](claude-code-web-environment.md) — the Claude Code on the web equivalent (network access, setup script, env vars).
- [cursor-backend-mcp.md](cursor-backend-mcp.md) — MCP endpoint for tooling in Cursor when the API runs with `ENABLE_MCP_SERVER=true`.
- [getting-started/setup.md](../getting-started/setup.md) — Local human setup and validation commands.
