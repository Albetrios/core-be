#!/usr/bin/env bash
#
# One-shot front-load of EVERY prerequisite for the comprehensive journey load test.
# Captures all the settings/fixes discovered the hard way (see COMPREHENSIVE-JOURNEY.md), so a run
# never stalls mid-flight to change a setting. Idempotent; safe to re-run.
#
#   bash src/tests/load/k6/setup-loadtest.sh [VUS] [WORKERS]
#       VUS     (default 100)  sizes the credential-pool seed
#       WORKERS (default 10)   sizes the cluster + DB pool (N×pool ≤ Postgres max − 10)
#
# Then:   node src/tests/load/k6/check-prereqs.mjs   (auto-run at the end)
#         VUS=<n> DURATION=60s k6 run src/tests/load/k6/scenarios/comprehensive-journey.js
#
# Teardown:  bash src/tests/load/k6/setup-loadtest.sh --teardown
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BAK=/tmp/.env.local.loadtest.bak

if [ "${1:-}" = "--teardown" ]; then
  echo "Teardown: stop cluster + restore .env.local (tracked files are left as-is)"
  pkill -f cluster-run.mjs 2>/dev/null || true
  [ -f "$BAK" ] && cp "$BAK" .env.local && echo "  .env.local restored from backup"
  echo "Done. Postgres stays at max_connections=500 (harmless for dev); DB seed/pool are reusable."
  exit 0
fi

VUS="${1:-100}"
WORKERS="${2:-10}"
# Connection budget the server asserts at boot: (API replicas + worker replicas) × DATABASE_POOL_MAX
# ≤ POSTGRES_MAX(500) − POSTGRES_RESERVED(10) = 490. The 1 worker process counts, hence WORKERS + 1.
POOL=$(( 490 / (WORKERS + 1) )); [ "$POOL" -gt 100 ] && POOL=100
NEEDED=$(( VUS * 14 / 10 ))   # +40% headroom (~20% of users are MFA-blocked + margin)
DBURL_RE='s#.*DATABASE_URL=##'

setkv() {
  local k="$1" v="$2"
  if grep -qE "^$k=" .env.local; then sed -i '' -e "s#^$k=.*#$k=$v#" .env.local
  else printf '%s=%s\n' "$k" "$v" >> .env.local; fi
}

echo "==> Load-test setup: VUS=$VUS, WORKERS=$WORKERS, DB pool=$POOL"

echo "[1/7] back up .env.local + apply load-test env overrides"
[ -f "$BAK" ] || cp .env.local "$BAK"
setkv NODE_ENV development                       # non-production runtime (CAPTCHA_FAIL_OPEN defaults true)
setkv RATE_LIMIT_RELAXED_CAPS true                # per-route rate caps -> 5000 (previously implied by the old test runtime)
setkv CAPTCHA_PROVIDER disabled
# Relax the boot-time safety checks for the local Docker Postgres/Redis (plaintext, no reverse proxy);
# they default hardened under development (were warn-only pre-refactor via host auto-detection).
setkv DATABASE_TLS_ENFORCED false
setkv DATABASE_RLS_SAFETY_ENFORCED false
setkv REDIS_TLS_ENFORCED false
setkv TRUST_PROXY_REQUIRED false
setkv PORT 3001
setkv RATE_LIMIT_MAX 100000000            # global limiter never rejects (one source IP)
setkv WEBHOOK_URL_ALLOWLIST example.com   # create-webhook host passes SSRF/allowlist
setkv SENTRY_DSN ""                        # optional; ~0ms impact
setkv MEMBER_ROLE_MAX_PER_ORG 500          # role create/delete under concurrency
setkv POSTGRES_MAX_CONNECTIONS 500         # budget check reads this from env
setkv DATABASE_POOL_MAX "$POOL"
setkv DEPLOYMENT_API_REPLICA_COUNT "$WORKERS"
setkv DEPLOYMENT_WORKER_REPLICA_COUNT 1

echo "[2/7] ensure Docker stack + Postgres max_connections=500 + Redis host port-forward"
SONAR=0 docker compose up -d postgres redis >/dev/null 2>&1 || true
for i in $(seq 1 30); do docker exec core-be-postgres pg_isready -U core -d core >/dev/null 2>&1 && break; sleep 0.5; done
MC=$(docker exec core-be-postgres psql -U core -d core -tAc "show max_connections" 2>/dev/null | tr -d ' ')
if [ "${MC:-0}" -lt 500 ]; then
  echo "      max_connections=$MC < 500 -> recreating Postgres (data persists)"
  docker compose up -d --force-recreate postgres >/dev/null 2>&1
  for i in $(seq 1 30); do docker exec core-be-postgres pg_isready -U core -d core >/dev/null 2>&1 && break; sleep 0.5; done
fi
echo "      Postgres max_connections=$(docker exec core-be-postgres psql -U core -d core -tAc 'show max_connections' 2>/dev/null | tr -d ' ')"
# Redis: verify the HOST port-forward, not just the container. OrbStack/Docker Desktop can leave
# the forward half-open (TCP accepted then dropped -> ioredis "Connection is closed" -> the server
# fails to boot) while `docker exec redis-cli ping` still PONGs. Restart the container to re-bind it.
REDISURL=$(grep -E '^REDIS_URL=' .env.local | head -1 | sed 's#.*REDIS_URL=##' | tr -d '"')
redis_host_ok() { REDIS_URL="${REDISURL:-redis://localhost:6379}" node -e 'const R=require("ioredis");const c=new R(process.env.REDIS_URL,{maxRetriesPerRequest:1,retryStrategy:()=>null,reconnectOnError:()=>false});const t=setTimeout(()=>process.exit(1),2500);c.ping().then(()=>{clearTimeout(t);process.exit(0)}).catch(()=>{clearTimeout(t);process.exit(1)})' >/dev/null 2>&1; }
if ! redis_host_ok; then
  echo "      Redis host port-forward half-open -> restarting container"
  docker restart core-be-redis >/dev/null 2>&1
  for i in $(seq 1 20); do redis_host_ok && break; sleep 0.5; done
fi
echo "      Redis host port-forward: $(redis_host_ok && echo OK || echo FAILED)"

echo "[3/7] build + copy runtime assets to dist (tsc skips .lua/.json/.sql/.html — they're read at runtime)"
pnpm build >/dev/null
rsync -a --include='*/' --include='*.lua' --include='*.html' --include='*.json' --include='*.sql' --exclude='*' src/ dist/src/

echo "[4/7] credential pool (need ~$NEEDED users for $VUS VU after MFA-blocked)"
POOL_FILE=src/tests/load/k6/data/credential-pool.json
HAVE=$(node -e "try{console.log(require('./$POOL_FILE').length)}catch{console.log(0)}")
if [ "${HAVE:-0}" -lt "$NEEDED" ]; then
  ORGS=$(( (NEEDED + 11) / 12 ))
  echo "      have $HAVE < $NEEDED -> seeding $ORGS organizations x 12 users"
  ALLOW_BULK_SEED=1 BULK_PROFILE=demo BULK_ORGS="$ORGS" BULK_USERS_PER_ORG=12 pnpm db:seed:bulk >/dev/null 2>&1
  pnpm tool:load-test-credential-pool >/dev/null 2>&1
fi
echo "      pool: $(node -e "console.log(require('./$POOL_FILE').length)") users"

echo "[5/7] clean leaked test data + stale rate-limit keys"
DBURL=$(grep -E '^DATABASE_URL=' .env.local | head -1 | sed "$DBURL_RE" | tr -d '"')
node -e '
const sql=require("postgres")(process.argv[1],{max:1});
(async()=>{
  const L=["Role %","Member Role %","X-%","LC-%","ConcRole%","r-%","diag%","k6%"];
  await sql`delete from tenancy.memberships where role_id in (select id from tenancy.roles where name like any(${L}))`;
  const r=await sql`delete from tenancy.roles where name like any(${L})`;
  const u=await sql`delete from upload.uploads where status = ${"PENDING"}`;
  console.log("      deleted leaked roles="+r.count+" pending-uploads="+u.count);
  await sql.end();
})().catch(e=>console.log("      cleanup note:",e.message));
' "$DBURL"
docker exec core-be-redis sh -c "redis-cli --scan --pattern '*rate*limit*' | xargs -r redis-cli del" >/dev/null 2>&1 || true

echo "[6/7] start cluster ($WORKERS workers on :3001)"
pkill -f cluster-run.mjs 2>/dev/null || true; sleep 1
CLUSTER_WORKERS="$WORKERS" nohup node cluster-run.mjs > /tmp/loadtest-server.log 2>&1 &
for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:3001/livez 2>/dev/null && break; sleep 0.5; done
echo "      livez -> $(curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/livez) ($(grep -ciE 'Server listening at http://127' /tmp/loadtest-server.log) workers)"

echo "[7/7] verify prerequisites"
VUS="$VUS" node src/tests/load/k6/check-prereqs.mjs
