# Local dashboards (dev tooling)

A one-command **control room** for the running core-be stack — open every local dashboard
from one page, with no browser extension.

```sh
pnpm dashboards:up        # Postgres/Redis/Sonar + API/worker/Studio + this hub (detached)
pnpm dashboards:status    # live status + links (read-only)
pnpm dashboards:down      # stop the node processes (--all also stops the containers)
pnpm dashboards:restart
pnpm dashboards:proxy     # just the auth proxy + hub (when the stack is already running)
```

Then open **<http://localhost:3010/>**.

## Fronting a deployed environment (development)

The same hub can front a **deployed** API instead of the Compose stack — the proxy reaches it over
HTTPS and injects the tokens from that environment's `.env.<environment>` file (the file
`pnpm github:sync` pushes), so Bull Board, `/metrics` and the Scalar reference open in a plain
browser tab exactly like the local ones:

```sh
pnpm dashboards:proxy:development   # → http://localhost:3011/  (development on Railway)
```

Which is `TARGET_ENV=development API_ORIGIN=https://development--core-be.cresence.skin PROXY_PORT=3011 pnpm dashboards:proxy` —
any origin works, so a different `API_ORIGIN` fronts another deployment.

- **The target must have the dashboards enabled** (`ENABLE_QUEUE_DASHBOARD=true` and
  `METRICS_ENABLED=true` on its GitHub Environment → Railway) — off, they answer 404 and the hub shows
  them down.
- **Do NOT set `ENABLE_API_REFERENCE=true` on a deployed target.** `@scalar/fastify-api-reference` is a
  devDependency and the runtime image is installed with `--prod`, so the flag makes the API crash-loop
  at boot (`Cannot find package '@scalar/fastify-api-reference'`). Hosted API docs live in the Scalar
  Registry / Postman (`pnpm docs:upload:hosted`, published by the post-merge deploy); the hub's
  "API Reference" pill therefore stays red against a remote target.
- **Login user:** the proxy signs in as `DEMO_EMAIL` / `DEMO_PASSWORD` — on a deployed target that must be
  a real super_admin there (listed in that environment's `GLOBAL_ADMIN_EMAILS`); the local
  `demo@example.com` seed does not exist remotely. The bypass header it sends is honoured only where
  `CAPTCHA_BYPASS_ALLOWED=true` (development is; production is not).
- **Local-only sidecars:** the worker health server, SonarQube and Drizzle Studio have no public URL, so
  against a remote target they are not probed and their pills stay grey; the Runtime "Worker" column
  and worker queue stats are empty.
- The footer badge shows the fronted environment and origin so two hubs (local on `:3010`, development
  on `:3011`) are never confused.
- **Browse the development database:** `pnpm db:studio:development` runs Drizzle Studio on `:4993`
  against `DATABASE_MIGRATION_URL` from `.env.development` (the Neon **owner** role — it has
  `BYPASSRLS`, which is the only way to see rows: the app login is `FORCE ROW LEVEL SECURITY`-scoped
  and shows every tenant table as empty without a request context). Owner means full write access
  to development data — browse, don't bulk-edit. Redis on Railway is on the private network
  (`redis.railway.internal`), so queues are only reachable through the API's Bull Board, never directly.

## Hosting the hub for an environment (Railway)

The same proxy runs as a **tiny extra Railway service** next to `api` and `worker`, so a deployed
environment gets this one-screen control room at its own URL (e.g.
`https://development--dashboards.<your-domain>`), no laptop needed. It has zero npm dependencies;
`Dockerfile.dashboards` copies `proxy.mjs` + `hub.html` and fetches the vendored assets.

Hosted mode is opt-in via `HUB_BIND=0.0.0.0` and then **requires `HUB_AUTH="user:password"`** — the
proxy refuses to boot without it, because it injects a super_admin Bull Board session and the
metrics token into every request. Every route is HTTP basic-auth checked except `GET /_health`
(the platform health check, reveals nothing). The login is your team's shared hub password; rotate
it by changing the variable.

Create the service once in the Railway UI (no CI change): **New service → GitHub repo (this one)
→ Settings → Build → Dockerfile path `Dockerfile.dashboards`**, watch branch `main`, then set:

| Variable | Value |
| -------- | ----- |
| `HUB_BIND` | `0.0.0.0` |
| `HUB_AUTH` | `ops:<strong password>` |
| `API_ORIGIN` | the API service's public origin (e.g. `https://development--core-be.<domain>`) |
| `TARGET_ENV` | `development` (label only — there is no env file in the image) |
| `METRICS_SCRAPE_TOKEN` | same value as the API service |
| `DEMO_EMAIL` / `DEMO_PASSWORD` | a super_admin on that API (listed in its `GLOBAL_ADMIN_EMAILS`) |

Then **Settings → Networking → Generate/Custom domain** and set the health-check path to
`/_health`. The API must have `ENABLE_QUEUE_DASHBOARD=true` and `METRICS_ENABLED=true` (see above).
Worker health, SonarQube and Drizzle Studio stay unavailable — they have no public URL.

## Humans use the UI · agents use the data tools

The HTML hub (`hub.html` on `:3010`) is **for humans**. An **AI agent asked to monitor the stack should never read or screenshot the UI** — it reads the *same data the hub renders*, as structured tool output, through the **`dashboards` MCP server** (`mcp.mjs`): `local_stack_status`, `local_metrics`, `local_queue_stats`, `local_worker_health`.

The **`stack-monitor` sub-agent** ([`agent-os/agents/stack-monitor.md`](../../../agent-os/agents/stack-monitor.md)) wraps those tools: spawn it for a one-line health verdict plus any anomalies (down services, failed jobs, DLQ depth, event-loop spikes, disconnected dependencies). For continuous monitoring, drive it on an interval and pass back the previous verdict so it reports *deltas*, not a steady state:

```sh
#   one check        → spawn the stack-monitor agent once
#   continuous       → /loop 60s use the stack-monitor agent to check the stack; pass it the previous verdict
```

The MCP server reads the proxy on `:3010`, so `pnpm dashboards:up` (or `pnpm dashboards:proxy`) must be running first.

## Files

| File | Role |
| ---- | ---- |
| `cli.sh` | Orchestrator — starts/stops the stack (detached) and prints status. |
| `proxy.mjs` | Auth proxy on `:3010` — serves the hub, injects tokens so the gated dashboards (`/metrics`, `/admin/queues`) open in any browser, and exposes `/_status`, `/_worker/*`, `/_hub/tw.js`, `/_hub/gridstack.{js,css}`. |
| `hub.html` | The single-page UI (Tailwind + shadcn light/dark theme). Status-page IA: a compact verdict **hero** (alerts cycle one-at-a-time + an **all N** toggle) → **Vital signs** = a compact **launcher strip** of dashboard-link pills (status LED + latency + copy; SonarQube's login is a click-to-copy badge) → a **Runtime** (Server vs Worker: Memory / Heap / Event-loop / CPU / **DB pool** utilization bar / Uptime) + **System health** matrix (Dependency × API/Worker) on the left with the **Requests** table on the right (`flex-1 basis-[400px]`, so they fill the available width and reflow to stacked below ~800px) → a **Queues** section led by its KPI summary (throughput / waiting / failed / DLQ, each with an **(i)** info tooltip) over the per-queue list (**pastel state progress bar** + total + one legend; hover any row for the full breakdown) + a **launcher** (copy button at the end of each URL). A **Requests** table lists top app routes by traffic with avg latency + 5xx counts (parsed label-aware from `http_request_duration_seconds`), and the **hero folds in reliability alarms** (stripe-webhook / event-handler / unhandled-rejection / commit-dispatch counters) when >0. Hovering a Runtime cell reveals the full detail (event-loop p50/p90/max, CPU user/system, heap total + external, GC runs, libuv handles); hovering a queue row shows its full state breakdown + last-run time. Queues also surfaces Mail-outbox + avg job-duration KPIs; the footer shows the Node version. The header shows **human-readable global freshness** ("updated 3s ago" — every section refreshes together in one request) + a manual **↻**. Polls server + worker metrics every 10s, holds last-good values on a failed poll (dims a `stale`-tagged card). The three panels (**Vital signs**, **Traffic**, **Jobs & queues**) are a **draggable + resizable grid** (gridstack) — drag by a panel header, resize from the bottom-right grip; the layout persists per browser and double-clicking a header resets it. Read live by the proxy — edit and refresh, no restart. |
| `mcp.mjs` | MCP server exposing the stack as read-only tools (`local_stack_status`, `local_worker_health`, `local_queue_stats`, `local_metrics`). Registered as the on-demand `dashboards` server in `.mcp.example.json`. |
| `tailwind.js` | Vendored Tailwind Play CDN (gitignored, regenerable). |
| `gridstack.js` / `gridstack.css` | Vendored [gridstack](https://gridstackjs.com) 11 for the draggable/resizable panel grid (gitignored, regenerable). |

## The dashboard login user

Bull Board (`/admin/queues`) needs a real logged-in **super_admin** — a minted token alone is
rejected. So the proxy signs in as a demo user to get one:

- **Credentials:** `DEMO_EMAIL` / `DEMO_PASSWORD` env, default **`demo@example.com` / `DemoPassword123!`**
  (read identically by `proxy.mjs` and the seed below — keep the defaults in sync).
- **Super_admin:** the email must be listed in `GLOBAL_ADMIN_EMAILS` (super_admin is global,
  not organization-scoped). `dashboards:up` warns if it isn't.
- **Ensured at startup:** `dashboards:up` runs **`pnpm db:seed:demo-admin`** after `db:migrate`
  ([`src/scripts/seed/ensure-demo-admin.ts`](../../../src/scripts/seed/ensure-demo-admin.ts)) —
  idempotent, creates the demo user + organization + Admin role + membership, and **resets the password**
  so a fresh DB (or one left with only faker users by `db:seed:bulk`) still authenticates. Run it
  by hand any time Bull Board 502s: `pnpm db:seed:demo-admin`.

## Notes

- The proxy injects the `METRICS_SCRAPE_TOKEN` and a self-refreshing super_admin JWT, so the
  token-gated dashboards open in a plain browser navigation.
- Vendored Tailwind is gitignored; fetch it once if missing (the proxy prints this hint):
  `curl -fsSL https://cdn.tailwindcss.com -o tooling/dev/dashboards/tailwind.js`.
- Vendored gridstack (the resizable panel grid) is gitignored too; fetch once if missing
  (the proxy prints this hint): `curl -fsSL https://cdn.jsdelivr.net/npm/gridstack@11/dist/gridstack-all.min.js -o tooling/dev/dashboards/gridstack.js`
  and `curl -fsSL https://cdn.jsdelivr.net/npm/gridstack@11/dist/gridstack.min.css -o tooling/dev/dashboards/gridstack.css`.
  Without them the hub falls back to plain stacked panels.
- Logs and pidfiles live in `.dashboards/` at the repo root (gitignored).
- The MCP server reads from the proxy on `:3010`, so run `pnpm dashboards:up` first; its tools
  return a clear hint if the proxy is not running.
