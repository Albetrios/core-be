# Load Testing Monitoring

A recording reverse proxy on **:4985** with a live dashboard, for reading what a load run actually
did. Point k6 at it instead of the API and every call is captured and grouped per route as it lands.

```bash
pnpm load:monitor                     # proxy + dashboard on http://localhost:4985
BASE_URL=http://localhost:4985 VUS=50 k6 run src/tests/load/k6/scenarios/fe-login-to-org.js
```

## What it is for

k6 prints its summary only once the run has finished, and only the numbers it was asked to collect.
This shows the run **while it happens** — which route is being hit, what came back, and where the
time is going — and it keeps the full request and response of every call, so a failure can be read
rather than guessed at. That is the difference between "19 calls failed" and "19 calls returned 503
from the overload guard".

## What it is NOT

Not application monitoring, and not a second copy of one. Production signals come from `/metrics`
(Prometheus), Sentry, and Bull Board at `/admin/queues`, and the Grafana definitions live in
`tooling/dev/dashboards/`. This tool holds everything in memory, keeps whole request and response
bodies, has no authentication, and disappears when you stop it. **Loopback development only** —
never put it in front of a deployed API.

The name carries the qualifier for a reason. "Load **Testing** Monitoring" is monitoring *of a load
test* — it exists for the minutes a run takes and then goes away. An unqualified "api-monitor", which
this was once called, reads as monitoring *of the API*, a job the list above already covers.

## Endpoints

| Endpoint | Purpose |
| -------- | ------- |
| `/` | Dashboard — per-route calls, ok/error/429 counts, avg, p95, max, total time |
| `/__monitor/stream` | Server-sent events feed of calls as they land |
| `/__monitor/stats` | Per-route aggregates as JSON |
| `/__monitor/calls` | Recorded calls (`?limit=`) with headers and bodies |
| `/__monitor/clear` | `POST` — reset counters between runs |
| `/__monitor/run` | `POST` — a scenario announces its shape (VUs, routes, pool) so the board can show the command that produced the numbers |
| everything else | proxied to the upstream API |

## Configuration

**Port 4985 is fixed and not configurable.** It sits beside the DB viewer's 4984 so the loopback dev
tools occupy one obvious band, and it is deliberately not read from the environment: a bare `PORT`
is the API server's own variable (env schema, default 3000), so a shell exporting it for the API
would silently move this proxy too.

| Env | Default | Purpose |
| --- | ------- | ------- |
| `LOAD_MONITOR_UPSTREAM` | `http://localhost:3000` | The API to forward to |

## Reading the numbers

The proxy sits in the request path, so it adds latency and a second event loop on the same box.
Compare monitor-to-monitor, never monitor-to-direct. Before quoting any before/after, read
[Trusting a result](../../docs/reference/testing/load-testing.md#trusting-a-result) — run-to-run
variance on a co-located box has been measured at 2.07x.

No dependencies: Node built-ins only.
