# Docker images

How production containers are built and what they include.

Requires **Docker BuildKit** (`export DOCKER_BUILDKIT=1` or Docker Desktop default).

## Images

| File                | Purpose                                                          | CMD                                           |
| ------------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| `Dockerfile`        | Multi-target: API (`api`) and worker (`worker`)                  | `node dist/server.js` / `node dist/worker.js` |
| `Dockerfile.worker` | Worker-only build (stages synced with `Dockerfile`; no MCP docs) | `node dist/worker.js`                         |
| `Dockerfile.agent`  | Cursor cloud agent (full dev deps)                               | —                                             |

Local infra: `docker-compose.yml` (Postgres, Redis with `restart: unless-stopped`; optional Toxiproxy chaos profile; optional **`smoke`** profile for API container testing).

## Keeping `Dockerfile.worker` in sync

[`Dockerfile.worker`](../../Dockerfile.worker) duplicates the `build` and `runtime` stages from [`Dockerfile`](../../Dockerfile) (without MCP generation). Railway expects this filename.

When you change **build** or **runtime** in `Dockerfile`, update `Dockerfile.worker` to match, then run:

```bash
pnpm docker:check-sync
```

CI runs the same check before image builds ([`tooling/ci/check-dockerfile-sync.mjs`](../../tooling/ci/check-dockerfile-sync.mjs)).

## Multi-target layout (`Dockerfile`)

| Stage     | Purpose                                                           |
| --------- | ----------------------------------------------------------------- |
| `build`   | Dev deps, compile TypeScript; optional MCP asset generation       |
| `runtime` | Prod `node_modules`, `dist/`, `migrations/`, locales, `USER node` |
| `worker`  | Worker CMD only (no `docs/`)                                      |
| `api`     | Default final stage — MCP docs, `HEALTHCHECK`, `EXPOSE 3000`      |

**Build args:**

| Arg                 | Default   | Use                                                                                     |
| ------------------- | --------- | --------------------------------------------------------------------------------------- |
| `NODE_VERSION`      | `24.18.1` | Pinned Node.js patch (`.nvmrc`, `.node-version`, CI)                                    |
| `PNPM_VERSION`      | `11.1.1` | Matches `package.json` `packageManager`                                                 |
| `GENERATE_MCP_DOCS`    | `true`    | When `true`, runs `pnpm routes:catalog` + `pnpm docs:generate:multilang` in build stage |
| `INSTALL_MCP_OPTIONAL` | `false`   | When `true`, runtime `pnpm install --prod` includes optional `@modelcontextprotocol/sdk`; default omits it (`--no-optional`) |
| `BUILD_REVISION`       | `unknown` | OCI label `org.opencontainers.image.revision` (CI passes `github.sha`)                  |
| `IMAGE_SOURCE`         | `unknown` | OCI label `org.opencontainers.image.source` (CI passes repo URL)                        |

**pnpm install:** Production Dockerfiles intentionally avoid BuildKit `type=cache` mounts. Railway requires cache mount IDs to be hardcoded with a service-specific `s/<service-id>-...` prefix, which is not portable for this repo's shared API/worker Dockerfiles across multiple environments. Docker layer caching still applies to the `package.json` + `pnpm-lock.yaml` install layers.

### Build commands (manual)

```bash
export DOCKER_BUILDKIT=1

# API (default: last stage is api; MCP SDK omitted from node_modules)
docker build --target api \
  --build-arg GENERATE_MCP_DOCS=true \
  -t core-be .

# API with MCP runtime (ENABLE_MCP_SERVER=true in deploy)
docker build --target api \
  --build-arg GENERATE_MCP_DOCS=true \
  --build-arg INSTALL_MCP_OPTIONAL=true \
  -t core-be-mcp .

# Shorthand
docker build -t core-be .

# Worker (Railway path)
docker build -f Dockerfile.worker -t core-be-worker .

# Worker via main Dockerfile
docker build --target worker \
  --build-arg GENERATE_MCP_DOCS=false \
  -t core-be-worker .
```

### Build commands (docker bake)

Requires `docker buildx`. Builds from main `Dockerfile` only (not `Dockerfile.worker`):

| Script      | Command                                                  |
| ----------- | -------------------------------------------------------- |
| Both images | `pnpm docker:build`                                      |
| API only    | `pnpm docker:build:api` → tag `core-be:latest`           |
| Worker only | `pnpm docker:build:worker` → tag `core-be-worker:latest` |

See [`docker-bake.hcl`](../../docker-bake.hcl). CI still runs `docker build -f Dockerfile.worker` so the Railway Dockerfile is exercised.

## API image

**Build stage** compiles TypeScript and (when `GENERATE_MCP_DOCS=true`) generates runtime docs used by MCP:

```dockerfile
RUN pnpm build && pnpm build:check \
  && if [ "$GENERATE_MCP_DOCS" = "true" ]; then \
       pnpm routes:catalog && pnpm docs:generate:multilang; \
     fi
```

**Runtime (`api` target)** copies:

- `dist/`, `migrations/`, `src/shared/locales/`
- `docs/routes.txt`, `docs/openapi/` — for `ENABLE_MCP_SERVER` (`core-be://routes`, `core-be://openapi` resources)

**MCP SDK:** `@modelcontextprotocol/sdk` is an **optional** dependency. Production images omit it by default (`INSTALL_MCP_OPTIONAL=false`). When `ENABLE_MCP_SERVER=true`, set `INSTALL_MCP_OPTIONAL=true` at image build time (or run `pnpm install` without `--no-optional` outside Docker).

**Health:** `HEALTHCHECK` uses Node 24 `fetch` against `GET http://127.0.0.1:3000/livez` (liveness; no extra OS packages).

**`.dockerignore`:** Host `docs/` is excluded from the build context; docs are **generated inside the build stage**, not copied from the host.

## Worker image (`Dockerfile.worker`)

Standalone Dockerfile with the same `build` / `runtime` pattern as the root file but **without** MCP generation or `docs/` copies. Workers do not serve HTTP or MCP.

**Health / monitoring:** No `HEALTHCHECK` in the worker image. Use orchestrator process monitoring (e.g. Railway restarts on exit, logs/metrics).

**Railway:** `reusable-railway-deploy.yml` deploys the scanned GHCR worker image to the separate worker service. Set `RAILWAY_WORKER_SERVICE_ID` in the GitHub environment so CD can sync shared variables and trigger the redeploy. Worker readiness is gated only by the Railway deployment terminal status — Railway flips the deployment to SUCCESS once the in-pod `Dockerfile.worker` HEALTHCHECK (`127.0.0.1:9090/readyz`) returns 200, which already covers process up + dependency probes + queue heartbeats. The runner cannot probe further: the worker has no public domain and Postgres/Redis live on `*.railway.internal`, unreachable from GitHub Actions hosts.

## Running production images locally

The `runtime` stage sets `ENV NODE_ENV=production`. Override at `docker run` / compose when smoke-testing the image.

| `NODE_ENV`   | Use in container? | Notes                                                                                                                                                     |
| ------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `production` | Default in image  | Requires `JWT_PRIVATE_KEY` + `JWT_PUBLIC_KEY` (RS256), `SECRETS_ENCRYPTION_KEY`, `ALLOWED_ORIGINS`, retention vars, and full deploy secrets — see [env schema](../../src/shared/config/env-schema.ts). |
| `local`      | Do not use        | Names a developer machine, not a container: the loader reads `.env.local`, which is dockerignored and therefore absent from the image. Pretty logging no longer crashes it — [`buildPinoPrettyTransport`](../../src/shared/utils/http/fastify-server.util.ts) degrades to JSON and warns when the pruned `pino-pretty` cannot be resolved. |
| `test`       | Smoke / CI        | Uses the same RS256 + encryption env contract, with test fixtures supplied by CI/setup — same as the [PR CI docker-run job](../../.github/workflows/pr-ci.yml).            |

### Compose smoke profile (recommended)

Runs the API image on the compose network (`postgres` / `redis` hostnames). Stop host `pnpm dev` if port 3000 is in use.

```bash
pnpm compose:up
pnpm compose:wait          # optional: wait for Postgres
pnpm db:migrate            # if DB is empty — required for connected health
pnpm docker:smoke:up       # builds api-smoke on first run (profile smoke)
curl -sf http://localhost:3000/readyz
pnpm docker:smoke:logs     # optional
pnpm docker:smoke:down
```

`api-smoke` uses `NODE_ENV=development` and the same core env vars as CI. It does not start the BullMQ worker.

### Manual `docker run` (alternative)

```bash
export DOCKER_BUILDKIT=1
docker build --target api -t core-be:local .
pnpm compose:up
docker run --rm -p 3000:3000 \
  -e NODE_ENV=development \
  `# boot-time safety checks default hardened; relax them for the plaintext local Postgres/Redis:` \
  -e DATABASE_TLS_ENFORCED=false -e DATABASE_RLS_SAFETY_ENFORCED=false \
  -e DATABASE_CONNECTION_BUDGET_ENFORCED=false -e REDIS_TLS_ENFORCED=false -e TRUST_PROXY_REQUIRED=false \
  -e HOST=0.0.0.0 -e PORT=3000 \
  -e DATABASE_URL=postgresql://core:core@host.docker.internal:5432/core \
  -e REDIS_URL=redis://host.docker.internal:6379 \
  -e JWT_SECRET=test-jwt-secret-min-32-chars-xxxxxxxx \
  -e ALLOWED_ORIGINS=http://localhost:3000 \
  -e AUDIT_RETENTION_DAYS=90 -e AUTH_SESSION_RETENTION_DAYS=30 \
  core-be:local
```

On Linux without `host.docker.internal`, use compose smoke or map to `172.17.0.1`.

## Compose vs production

Default `docker compose up` runs **Postgres and Redis only**. Daily dev uses `pnpm dev` on the host. Production-like API in Docker is opt-in via the `smoke` profile or manual `docker run` above.

## CI

On **every pull request and push**, the `docker-build` job:

1. `node tooling/ci/check-dockerfile-sync.mjs`
2. Builds `core-be:ci` (API) and `core-be-worker:ci` (`Dockerfile.worker`)
3. Trivy-scans both images (CRITICAL/HIGH; fails the job on findings)
4. Worker: `node --check` + native module imports
5. API: run migrations in the container under `NODE_ENV=development`, verify the image boots

On **push to `main`** (after scan), images are pushed to GHCR:

- `ghcr.io/<owner>/<repo>/core-be-api:<commit-sha>` and `:latest`
- `ghcr.io/<owner>/<repo>/core-be-worker:<commit-sha>` and `:latest`

[reusable-railway-deploy.yml](../../.github/workflows/reusable-railway-deploy.yml) logs the expected GHCR refs and redeploys the configured Railway API and worker services with `railway redeploy --service ... --yes`. The current Railway CLI does not support `railway redeploy --image`.

Adds roughly 3–8 minutes to PR checks. See [cicd-and-deployment.md](ci-cd/cicd-and-deployment.md).

## When you change routes

1. `pnpm routes:catalog` — updates catalog + registry (local pre-commit always regenerates and stages `docs/routes.txt`).
2. `pnpm docs:generate:multilang` — updates OpenAPI (or `pnpm docs:check` in CI).
3. Rebuild the API image so MCP resources stay current.

See [architecture-consistency-roadmap-2026-05.md](../reviews/architecture-consistency-roadmap-2026-05.md).
