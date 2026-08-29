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
