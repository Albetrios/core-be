#!/usr/bin/env bash
# Local dashboards orchestrator for this project.
#
# Brings up Postgres / Redis / SonarQube (via OrbStack or Docker Desktop), then starts the
# API + worker + Drizzle Studio + an auth proxy DETACHED (nohup) so they survive your
# terminal / editor session, and prints the dashboard links with live status.
#
#   pnpm dashboards:up          # start everything, print links
#   pnpm dashboards:status      # probe live status + links (read-only)
#   pnpm dashboards:proxy       # auth proxy only — browser-friendly /admin/queues + /metrics
#   pnpm dashboards:down        # stop the node processes (containers stay up)
#   pnpm dashboards:down --all  # also stop Postgres / Redis / SonarQube containers
#   pnpm dashboards:restart     # down (node procs) then up
#
# Logs + pidfiles live in .dashboards/ (gitignored). Set SONAR=0 to skip SonarQube.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT" || exit 1
RUN_DIR="$ROOT/.dashboards"
mkdir -p "$RUN_DIR"

API_URL="http://localhost:3000"
WORKER_URL="http://localhost:9090"
SONAR_URL="http://localhost:9000"
STUDIO_LOCAL="http://127.0.0.1:4983"
STUDIO_URL="https://local.drizzle.studio"
PROXY_URL="http://localhost:3010"

c_green=$'\033[32m'; c_red=$'\033[31m'; c_yellow=$'\033[33m'; c_dim=$'\033[2m'; c_reset=$'\033[0m'
log()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$c_green" "$c_reset" "$*"; }
warn() { printf '%s!%s %s\n' "$c_yellow" "$c_reset" "$*"; }
err()  { printf '%s✗%s %s\n' "$c_red" "$c_reset" "$*"; }

env_val()   { grep -E "^$1=" .env.local 2>/dev/null | head -1 | cut -d= -f2-; }
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@" 2>/dev/null; }
is_up()     { case "$1" in 2*|3*|401) return 0;; *) return 1;; esac; }

ensure_engine() {
  if docker info >/dev/null 2>&1; then return 0; fi
  warn "Docker engine not reachable — trying to start it…"
  command -v orb >/dev/null 2>&1 && orb start >/dev/null 2>&1
  docker context use orbstack >/dev/null 2>&1
  [ -d /Applications/Docker.app ] && open -a Docker >/dev/null 2>&1
  for _ in $(seq 1 40); do docker info >/dev/null 2>&1 && break; done
  docker info >/dev/null 2>&1
}

start_proc() { # name  pattern  cmd...
  local name="$1" pattern="$2"; shift 2
  if pgrep -f "$pattern" >/dev/null 2>&1; then ok "$name already running"; return 0; fi
  nohup "$@" > "$RUN_DIR/$name.log" 2>&1 &
  local pid=$!; disown "$pid" 2>/dev/null || disown 2>/dev/null || true
  echo "$pid" > "$RUN_DIR/$name.pid"
  ok "$name started (pid $pid)  ${c_dim}→ .dashboards/$name.log${c_reset}"
}

stop_proc() { # name  pattern
  local name="$1" pattern="$2"
  if pgrep -f "$pattern" >/dev/null 2>&1; then pkill -f "$pattern" 2>/dev/null && ok "stopped $name"; else warn "$name not running"; fi
  rm -f "$RUN_DIR/$name.pid"
}

proxy_pid() { lsof -tiTCP:"${PROXY_URL##*:}" -sTCP:LISTEN 2>/dev/null | head -1; } # the LOCAL hub only (by port)

wait_up() { # url  label — waits through connection-refused (curl --retry-delay) while the server boots
  if curl -s -o /dev/null --retry 45 --retry-delay 1 --retry-connrefused --retry-max-time 60 "$1" 2>/dev/null; then
    ok "$2"; return 0
  fi
  err "$2 did not come up — check .dashboards/*.log"; return 1
}

precheck_env() {
  [ -f .env.local ] || { err ".env.local missing — run: pnpm setup:local"; exit 1; }
  [ "$(env_val ENABLE_API_REFERENCE)" = "true" ]   || warn "ENABLE_API_REFERENCE≠true — /reference will be hidden"
  [ "$(env_val ENABLE_QUEUE_DASHBOARD)" = "true" ] || warn "ENABLE_QUEUE_DASHBOARD≠true — /admin/queues will be hidden"
  [ "$(env_val CAPTCHA_PROVIDER)" = "turnstile" ]  || warn "CAPTCHA_PROVIDER≠turnstile — Bull Board login needs X-Captcha-Bypass enforced (see dashboards token hint)"
  local demo_email="${DEMO_EMAIL:-demo@example.com}"
  case ",$(env_val GLOBAL_ADMIN_EMAILS)," in
    *",$demo_email,"*) : ;;
    *) warn "GLOBAL_ADMIN_EMAILS lacks $demo_email — Bull Board login won't be super_admin" ;;
  esac
}

status_line() { # _  label  code  urlnotes
  if is_up "$3"; then printf '%s✓%s  %-22s %s\n' "$c_green" "$c_reset" "$2" "$4"
  else printf '%s✗%s  %-22s %s %s(%s)%s\n' "$c_red" "$c_reset" "$2" "$4" "$c_dim" "$3" "$c_reset"; fi
}

cmd_status() {
  local proxy_up=0; is_up "$(http_code "$PROXY_URL/livez")" && proxy_up=1
  local studio_code; studio_code="$(http_code "$STUDIO_LOCAL")"; [ "$studio_code" = 000 ] || studio_code=200
  log "Open directly in your browser (no auth):"
  status_line x "Scalar API reference" "$(http_code "$API_URL/reference/")" "$API_URL/reference/   ${c_dim}(keep the trailing slash)${c_reset}"
  status_line x "Health"               "$(http_code "$API_URL/livez")"      "$API_URL/livez · /readyz"
  status_line x "Worker readiness"     "$(http_code "$WORKER_URL/readyz")"  "$WORKER_URL/readyz"
  status_line x "SonarQube"            "$(http_code "$SONAR_URL")"          "$SONAR_URL   ${c_yellow}login: admin / admin${c_reset}"
  status_line x "Drizzle Studio"       "$studio_code"                       "$STUDIO_URL   ${c_dim}(open in Chrome)${c_reset}"
  echo
  log "Token-gated — open via the auth proxy (no browser extension needed):"
  if [ "$proxy_up" = 1 ]; then
    status_line x "Bull Board"  "$(http_code "$PROXY_URL/admin/queues")" "$PROXY_URL/admin/queues"
    status_line x "Metrics"     "$(http_code "$PROXY_URL/metrics")"      "$PROXY_URL/metrics"
  else
    warn "auth proxy not running — start it:  pnpm dashboards:proxy"
    log "  ${c_dim}(or open $API_URL/admin/queues · /metrics with a ModHeader 'Authorization: Bearer <token>' header)${c_reset}"
  fi
}

cmd_up() {
  precheck_env
  ensure_engine || { err "No Docker engine (start OrbStack/Docker Desktop) — aborting."; exit 1; }
  log "→ Postgres / Redis${SONAR:+/ SonarQube}…"
  pnpm compose:up   >/dev/null 2>&1 && ok "containers up"   || warn "compose:up reported issues"
  pnpm compose:wait >/dev/null 2>&1 && ok "postgres ready"  || warn "postgres wait timed out"
  log "→ migrations…"
  pnpm db:migrate   >/dev/null 2>&1 && ok "migrations applied" || warn "migrate failed (run: pnpm db:migrate)"
  log "→ demo super_admin (the user the proxy logs in as for Bull Board)…"
  pnpm db:seed:demo-admin >/dev/null 2>&1 \
    && ok "demo super_admin ready" \
    || warn "demo super_admin seed failed — Bull Board may 502 (run: pnpm db:seed:demo-admin)"
  if [ ! -f docs/openapi/openapi.json ]; then
    log "→ OpenAPI spec for /reference…"
    pnpm docs:generate >/dev/null 2>&1 && ok "spec generated" || warn "docs:generate failed"
  else ok "OpenAPI spec present"; fi
  log "→ API / worker / Drizzle Studio (detached)…"
  start_proc api    "src/server.ts" pnpm dev
  start_proc worker "src/worker.ts" pnpm dev:worker
  if pgrep -f "drizzle-kit.*studio" >/dev/null 2>&1; then ok "studio already running"; else
    DATABASE_URL="$(env_val DATABASE_URL)" nohup pnpm db:studio > "$RUN_DIR/studio.log" 2>&1 &
    local spid=$!; disown "$spid" 2>/dev/null || disown 2>/dev/null || true
    echo "$spid" > "$RUN_DIR/studio.pid"; ok "studio started (pid $spid)  ${c_dim}→ .dashboards/studio.log${c_reset}"
  fi
  # The proxy is matched by its listening port, not its command line: a second hub fronting a
  # deployed environment (`pnpm dashboards:proxy:development` on :3011) runs the same script.
  if [ -n "$(proxy_pid)" ]; then ok "proxy already running (pid $(proxy_pid))"; else
    nohup node tooling/dev/dashboards/proxy.mjs > "$RUN_DIR/proxy.log" 2>&1 &
    local ppid=$!; disown "$ppid" 2>/dev/null || disown 2>/dev/null || true
    echo "$ppid" > "$RUN_DIR/proxy.pid"; ok "proxy started (pid $ppid)  ${c_dim}→ .dashboards/proxy.log${c_reset}"
  fi
  log "→ readiness…"
  wait_up "$API_URL/livez"   "API     $API_URL"
  wait_up "$WORKER_URL/readyz" "worker  $WORKER_URL"
  echo; cmd_status
}

cmd_down() {
  local proxy_pid_value; proxy_pid_value="$(proxy_pid)"
  if [ -n "$proxy_pid_value" ]; then kill "$proxy_pid_value" 2>/dev/null && ok "stopped proxy"; else warn "proxy not running"; fi
  rm -f "$RUN_DIR/proxy.pid"
  stop_proc studio "drizzle-kit.*studio"
  stop_proc worker "src/worker.ts"
  stop_proc api    "src/server.ts"
  if [ "${1:-}" = "--all" ]; then
    log "→ stopping containers…"
    pnpm compose:down >/dev/null 2>&1 && ok "postgres/redis stopped" || warn "compose:down issue"
    docker compose -f docker-compose.sonar.yml down >/dev/null 2>&1 && ok "sonarqube stopped"
  else
    log "${c_dim}(containers left up — 'pnpm dashboards:down --all' stops them too)${c_reset}"
  fi
}

case "${1:-up}" in
  up)      cmd_up;;
  down)    shift || true; cmd_down "${1:-}";;
  status)  cmd_status;;
  restart) cmd_down; cmd_up;;
  *)       err "usage: cli.sh [up | down [--all] | status | restart]"; exit 1;;
esac
