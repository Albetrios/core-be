# Environment variable catalog

> **Generated** by `pnpm env:catalog` from `ENV_VAR_REGISTRY` + the env schema. Do not edit by hand.
> `pnpm env:catalog:check` verifies it is in sync (CI gate).

Allowed values + description come from the explicit registry; the **default** and **required/optional**
status are read from each Zod field, so this can never disagree with what boots. Registry coverage:
**12 / 234** variables migrated to an explicit `{ allowed, description }` entry.

| Variable | Allowed values | Default | In registry | Description |
| --- | --- | --- | :---: | --- |
| `ALLOWED_ORIGINS` | — | — *(required)* |  | — |
| `API_DOCS_BASE_URL` | — | — *(optional)* |  | — |
| `API_REFERENCE_ALLOW_PRODUCTION` | — | `false` |  | — |
| `AUDIT_EXPORT_BATCH_SIZE` | — | `5000` |  | — |
| `AUDIT_EXPORT_CRON` | — | — *(optional)* |  | — |
| `AUDIT_EXPORT_ENABLED` | — | `false` |  | — |
| `AUDIT_EXPORT_S3_PREFIX` | — | `audit/export` |  | — |
| `AUDIT_OUTBOX_DRAIN_BATCH_SIZE` | — | — *(optional)* |  | — |
| `AUDIT_OUTBOX_DRAIN_CRON` | — | — *(optional)* |  | — |
| `AUDIT_OUTBOX_DRAIN_MAX_ATTEMPTS` | — | — *(optional)* |  | — |
| `AUDIT_RETENTION_CRON` | — | — *(optional)* |  | — |
| `AUDIT_RETENTION_DAYS` | — | `365` |  | — |
| `AUTH_ANTI_ENUMERATION_MINIMUM_DURATION_MS` | — | `300` |  | — |
| `AUTH_FIXED_VERIFICATION_CODE` | — | — *(optional)* |  | — |
| `AUTH_SESSION_CLEANUP_CRON` | — | — *(optional)* |  | — |
| `AUTH_SESSION_MAX_AGE_DAYS` | — | `7` |  | — |
| `AUTH_SESSION_RETENTION_DAYS` | — | `30` |  | — |
| `BILLING_DUNNING_GRACE_DAYS` | — | `14` |  | — |
| `BLOCK_DISPOSABLE_EMAIL` | — | `true` |  | — |
| `CAPTCHA_BYPASS_ALLOWED` | — | `false` |  | — |
| `CAPTCHA_BYPASS_HEADER` | — | — *(optional)* |  | — |
| `CAPTCHA_FAIL_OPEN` | — | `false` |  | — |
| `CAPTCHA_PROVIDER` | — | `disabled` |  | — |
| `CAPTCHA_SECRET` | — | — *(optional)* |  | — |
| `COMMIT_DISPATCH_RECOVERY_CRON` | — | — *(optional)* |  | — |
| `COOKIE_SAMESITE` | — | `strict` |  | — |
| `COOKIE_SECURE` | — | `true` |  | — |
| `DATABASE_CONNECTION_BUDGET_ENFORCED` | — | `true` |  | — |
| `DATABASE_HTTP_STATEMENT_TIMEOUT_MS` | — | `5000` |  | — |
| `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` | — | — *(optional)* |  | — |
| `DATABASE_LOCK_TIMEOUT_MS` | — | `3000` |  | — |
| `DATABASE_MIGRATION_URL` | — | — *(optional)* |  | — |
| `DATABASE_POOL_ACTIVE_CRITICAL_RATIO` | — | `0.95` |  | — |
| `DATABASE_POOL_ACTIVE_WARN_RATIO` | — | `0.8` |  | — |
| `DATABASE_POOL_ALERT_CONSECUTIVE_POLLS` | — | `2` |  | — |
| `DATABASE_POOL_ALERT_POLL_INTERVAL_MS` | — | `5000` |  | — |
| `DATABASE_POOL_CLUSTER_CRITICAL_RATIO` | — | `0.95` |  | — |
| `DATABASE_POOL_CLUSTER_WARN_RATIO` | — | `0.8` |  | — |
| `DATABASE_POOL_CONNECT_TIMEOUT_SECONDS` | — | — *(optional)* |  | — |
| `DATABASE_POOL_IDLE_TIMEOUT_SECONDS` | — | — *(optional)* |  | — |
| `DATABASE_POOL_MAX` | — | `20` |  | — |
| `DATABASE_POOL_MAX_LIFETIME_SECONDS` | — | — *(optional)* |  | — |
| `DATABASE_RLS_SAFETY_ENFORCED` | — | `true` |  | — |
| `DATABASE_SSL_ENABLED` | — | `true` |  | — |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | — | — *(optional)* |  | — |
| `DATABASE_STATEMENT_TIMEOUT_MS` | — | — *(optional)* |  | — |
| `DATABASE_TLS_ENFORCED` | — | `true` |  | — |
| `DATABASE_URL` | — | — *(required)* |  | — |
| `DATABASE_WORKER_LOCK_TIMEOUT_MS` | — | `30000` |  | — |
| `DATABASE_WORKER_STATEMENT_TIMEOUT_MS` | — | `300000` |  | — |
| `DEPLOYMENT_API_REPLICA_COUNT` | — | — *(optional)* |  | — |
| `DEPLOYMENT_TOTAL_REPLICA_COUNT` | — | — *(optional)* |  | — |
| `DEPLOYMENT_WORKER_REPLICA_COUNT` | — | — *(optional)* |  | — |
| `DLQ_AUTO_RETRY_BATCH_SIZE` | — | `20` |  | — |
| `DLQ_AUTO_RETRY_COOLDOWN_MINUTES` | — | `30` |  | — |
| `DLQ_AUTO_RETRY_CRON` | — | — *(optional)* |  | — |
| `DLQ_AUTO_RETRY_ENABLED` | — | `true` |  | — |
| `DLQ_AUTO_RETRY_MAX_COUNT` | — | `3` |  | — |
| `DLQ_DEPTH_CRON` | — | — *(optional)* |  | — |
| `DLQ_DEPTH_WARN_THRESHOLD` | — | `10` |  | — |
| `EMAIL_FROM_ADDRESS` | — | — *(optional)* |  | — |
| `EMAIL_FROM_NAME` | — | — *(optional)* |  | — |
| `ENABLE_API_REFERENCE` | — | `false` |  | — |
| `ENABLE_MCP_SERVER` | — | `false` |  | — |
| `ENABLE_QUEUE_DASHBOARD` | — | `false` |  | — |
| `ENABLE_QUEUE_DASHBOARD_MUTATIONS` | — | `false` |  | — |
| `ENABLE_RESPONSE_ENCRYPTION` | — | `false` |  | — |
| `FASTIFY_CONNECTION_TIMEOUT_MS` | integer 1000–600000 (optional) | — *(optional)* | ✓ | Fastify connection timeout in milliseconds. |
| `FASTIFY_HEADERS_TIMEOUT_MS` | integer 1000–600000 (optional) | — *(optional)* | ✓ | Fastify headers timeout in milliseconds. |
| `FASTIFY_KEEP_ALIVE_TIMEOUT_MS` | integer 1000–600000 (optional) | — *(optional)* | ✓ | Fastify keep-alive timeout in milliseconds. |
| `FASTIFY_REQUEST_TIMEOUT_MS` | integer 1000–600000 (optional) | — *(optional)* | ✓ | Fastify request timeout in milliseconds. |
| `FRONTEND_URL` | — | — *(optional)* |  | — |
| `GLOBAL_ADMIN_ACCESS_TOKEN_EXPIRY_SECONDS` | — | `300` |  | — |
| `GLOBAL_ADMIN_EMAILS` | — | — *(optional)* |  | — |
| `HEALTH_VERBOSE_BODY_ENABLED` | — | `false` |  | — |
| `HSTS_INCLUDE_SUBDOMAINS` | — | `false` |  | — |
| `HSTS_PRELOAD_REGISTERED` | — | `false` |  | — |
| `HTTP_BIND_HOST` | non-empty string (host or IP) | `0.0.0.0` | ✓ | Fastify HTTP bind address (the worker health server also binds here). |
| `HTTP_SERVER_TIMING_ENABLED` | true \| false (or 1 \| 0) | `true` | ✓ | Emit a Server-Timing response header carrying total server-side processing time. |
| `I18N_REPORT_MISSING_KEYS` | — | `true` |  | — |
| `IDEMPOTENCY_CARDINALITY_CRITICAL_THRESHOLD` | — | `200000` |  | — |
| `IDEMPOTENCY_CARDINALITY_CRON` | — | — *(optional)* |  | — |
| `IDEMPOTENCY_CARDINALITY_SCAN_MAX` | — | `200000` |  | — |
| `IDEMPOTENCY_CARDINALITY_WARN_THRESHOLD` | — | `50000` |  | — |
| `IDEMPOTENCY_PER_ACTOR_CAP` | — | `1000` |  | — |
| `IDEMPOTENCY_PER_ACTOR_CAP_WINDOW_SECONDS` | — | `3600` |  | — |
| `INVITATION_MAX_PENDING_PER_ORG` | — | `100` |  | — |
| `JWT_PRIVATE_KEY` | — | — *(required)* |  | — |
| `JWT_PUBLIC_KEY` | — | — *(required)* |  | — |
| `JWT_SIGNING_KID` | — | `default` |  | — |
| `LOG_LEVEL` | fatal \| error \| warn \| info \| debug \| trace \| silent | `info` | ✓ | Pino log level. Enum-constrained so a typo fails at boot instead of silently degrading. |
| `LOG_PRETTY` | — | `false` |  | — |
| `MAIL_OUTBOX_RECLAIM_SENDING_MINUTES` | — | `30` |  | — |
| `MAIL_OUTBOX_SWEEP_BATCH_SIZE` | — | `100` |  | — |
| `MAIL_OUTBOX_SWEEP_PENDING_MINUTES` | — | `15` |  | — |
| `MAIL_OUTBOX_SWEEPER_CRON` | — | — *(optional)* |  | — |
| `MAX_TEAM_ORGANIZATIONS_PER_OWNER` | — | `20` |  | — |
| `MCP_CALL_API_ALLOW_MUTATIONS` | — | `false` |  | — |
| `MCP_CALL_API_ALLOWED_PATH_PREFIXES` | — | `` |  | — |
| `MEMBER_ROLE_MAX_PER_ORG` | — | `50` |  | — |
| `MEMBER_ROLE_TOMBSTONE_RETENTION_CRON` | — | — *(optional)* |  | — |
| `MEMBERSHIP_TOMBSTONE_RETENTION_CRON` | — | — *(optional)* |  | — |
| `METRICS_AUTH_REQUIRED` | — | `true` |  | — |
| `METRICS_ENABLED` | — | `true` |  | — |
| `METRICS_SCRAPE_TOKEN` | — | — *(optional)* |  | — |
| `MONTHLY_DATABASE_RESTORE_DRILL_NEON_API_KEY` | — | — *(optional)* |  | — |
| `NODE_ENV` | local \| development \| production | `local` | ✓ | Runtime environment name; names the .env file and gates the production-only refines. |
| `NOTIFICATION_RETENTION_CRON` | — | — *(optional)* |  | — |
| `NOTIFICATION_RETENTION_DAYS` | — | `90` |  | — |
| `OAUTH_GITHUB_CLIENT_ID` | — | — *(optional)* |  | — |
| `OAUTH_GITHUB_CLIENT_SECRET` | — | — *(optional)* |  | — |
| `OAUTH_GITHUB_REDIRECT_URI` | — | — *(optional)* |  | — |
| `OAUTH_GOOGLE_CLIENT_ID` | — | — *(optional)* |  | — |
| `OAUTH_GOOGLE_CLIENT_SECRET` | — | — *(optional)* |  | — |
| `OAUTH_GOOGLE_REDIRECT_URI` | — | — *(optional)* |  | — |
| `OPENAPI_SPEC_PATH` | — | — *(optional)* |  | — |
| `ORGANIZATION_API_KEY_MAX_PER_ORG` | — | `25` |  | — |
| `ORGANIZATION_API_KEY_TOMBSTONE_RETENTION_CRON` | — | — *(optional)* |  | — |
| `ORGANIZATION_NOTIFICATION_POLICY_MAX_PER_ORG` | — | `100` |  | — |
| `ORGANIZATION_NOTIFICATION_POLICY_TOMBSTONE_RETENTION_CRON` | — | — *(optional)* |  | — |
| `ORGANIZATION_TOMBSTONE_RETENTION_CRON` | — | — *(optional)* |  | — |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | — *(optional)* |  | — |
| `OTEL_SERVICE_NAME` | — | — *(optional)* |  | — |
| `OVERLOAD_DB_POOL_SHED_RATIO` | number 0–1 | `0.9` | ✓ | Fraction of DATABASE_POOL_MAX in-flight RLS checkouts at which the overload guard sheds requests. |
| `OVERLOAD_MAX_EVENT_LOOP_DELAY_MS` | integer 1–60000 | `250` | ✓ | Overload-guard shed threshold: p99 event-loop delay (ms) above which requests get a 503. |
| `PERSONAL_ORGANIZATION_ENABLED` | — | `true` |  | — |
| `PORT` | integer 1–65535 | `3000` | ✓ | HTTP port the API server binds to. |
| `POSTGRES_MAX_CONNECTIONS` | — | — *(optional)* |  | — |
| `POSTGRES_RESERVED_CONNECTIONS` | — | `10` |  | — |
| `POSTHOG_HOST` | — | — *(optional)* |  | — |
| `POSTHOG_KEY` | — | — *(optional)* |  | — |
| `POSTMAN_API_KEY` | — | — *(optional)* |  | — |
| `POSTMAN_WORKSPACE_ID` | — | — *(optional)* |  | — |
| `PROCESS_RSS_WARN_THRESHOLD_MB` | — | `512` |  | — |
| `PUBLIC_MEDIA_BASE_URL` | — | — *(optional)* |  | — |
| `QUEUE_DASHBOARD_ALLOW_PRODUCTION` | — | `false` |  | — |
| `QUEUE_WAITING_DEPTH_WARN_THRESHOLD` | — | `1000` |  | — |
| `RAILWAY_GIT_COMMIT_SHA` | — | — *(optional)* |  | — |
| `RAILWAY_SERVICE_ID` | — | — *(optional)* |  | — |
| `RAILWAY_TOKEN` | — | — *(optional)* |  | — |
| `RAILWAY_WORKER_SERVICE_ID` | — | — *(optional)* |  | — |
| `RATE_LIMIT_IN_MEMORY_FALLBACK_ALLOWED` | — | `false` |  | — |
| `RATE_LIMIT_MAX` | — | `100` |  | — |
| `RATE_LIMIT_RELAXED_CAPS` | — | `false` |  | — |
| `RATE_LIMIT_WINDOW_MS` | — | `60000` |  | — |
| `READYZ_503_ON_OPEN_CIRCUIT` | — | `false` |  | — |
| `READYZ_QUEUE_DEPTH_503_THRESHOLD` | — | `0` |  | — |
| `REDIS_BULLMQ_URL` | — | — *(optional)* |  | — |
| `REDIS_KEY_PREFIX` | — | — *(optional)* |  | — |
| `REDIS_MEMORY_CRITICAL_RATIO` | — | `0.95` |  | — |
| `REDIS_MEMORY_WARN_RATIO` | — | `0.85` |  | — |
| `REDIS_READY_CHECK_ENABLED` | — | `true` |  | — |
| `REDIS_TLS_ENFORCED` | — | `true` |  | — |
| `REDIS_URL` | — | — *(required)* |  | — |
| `RELEASE_PLEASE_TOKEN` | — | — *(optional)* |  | — |
| `RESEND_API_KEY` | — | — *(optional)* |  | — |
| `RESEND_HTTP_TIMEOUT_MS` | — | `30000` |  | — |
| `RESPONSE_ENCRYPTION_CURRENT_VERSION` | — | `v1` |  | — |
| `RESPONSE_ENCRYPTION_KEY` | — | — *(optional)* |  | — |
| `RESPONSE_ENCRYPTION_KEYS` | — | — *(optional)* |  | — |
| `S3_ACCESS_KEY_ID` | — | — *(optional)* |  | — |
| `S3_BUCKET` | — | — *(optional)* |  | — |
| `S3_CONNECTION_TIMEOUT_MS` | — | `5000` |  | — |
| `S3_ENDPOINT` | — | — *(optional)* |  | — |
| `S3_FORCE_PATH_STYLE` | — | `false` |  | — |
| `S3_MAX_ATTEMPTS` | — | `3` |  | — |
| `S3_REGION` | — | — *(optional)* |  | — |
| `S3_REQUEST_TIMEOUT_MS` | — | `15000` |  | — |
| `S3_SECRET_ACCESS_KEY` | — | — *(optional)* |  | — |
| `SCALAR_API_KEY` | — | — *(optional)* |  | — |
| `SCALAR_NAMESPACE` | — | — *(optional)* |  | — |
| `SCALAR_SLUG` | — | — *(optional)* |  | — |
| `SCHEDULER_ENABLED` | — | `true` |  | — |
| `SCHEDULER_REGISTRY_AUDIT_STRICT` | — | `true` |  | — |
| `SCHEDULER_TIMEZONE` | — | — *(optional)* |  | — |
| `SECRETS_ENCRYPTION_CURRENT_VERSION` | — | `v1` |  | — |
| `SECRETS_ENCRYPTION_KEY` | — | — *(required)* |  | — |
| `SECRETS_ENCRYPTION_KEYS` | — | — *(optional)* |  | — |
| `SENTRY_DEBUG` | — | `false` |  | — |
| `SENTRY_DSN` | — | — *(optional)* |  | — |
| `SENTRY_ENVIRONMENT` | — | — *(optional)* |  | — |
| `SENTRY_PROFILE_SAMPLE_RATE` | — | — *(optional)* |  | — |
| `SENTRY_REDUCED_SAMPLING` | — | `true` |  | — |
| `SENTRY_SLOW_TRANSACTION_MS` | — | `3000` |  | — |
| `SENTRY_TRACES_SAMPLE_RATE` | — | — *(optional)* |  | — |
| `SERVER_TIMING_COARSE` | — | `true` |  | — |
| `SESSION_ORIGIN_CSRF_REQUIRED` | — | `true` |  | — |
| `SHUTDOWN_DRAIN_ENABLED` | — | `true` |  | — |
| `SHUTDOWN_SKIP_SHARED_TEARDOWN` | — | `false` |  | — |
| `SHUTDOWN_TIMEOUT_MS` | — | — *(optional)* |  | — |
| `SONAR_ADMIN_PASSWORD` | — | — *(optional)* |  | — |
| `SONAR_TOKEN` | — | — *(optional)* |  | — |
| `STRIPE_HTTP_TIMEOUT_MS` | — | `30000` |  | — |
| `STRIPE_SECRET_KEY` | — | — *(optional)* |  | — |
| `STRIPE_WEBHOOK_EVENT_CATCHUP_CRON` | — | — *(optional)* |  | — |
| `STRIPE_WEBHOOK_EVENT_CATCHUP_PAGE_SIZE` | — | `100` |  | — |
| `STRIPE_WEBHOOK_EVENT_CATCHUP_WINDOW_MINUTES` | — | `60` |  | — |
| `STRIPE_WEBHOOK_EVENT_RECLAIM_BATCH_SIZE` | — | `100` |  | — |
| `STRIPE_WEBHOOK_EVENT_RECLAIM_CRON` | — | — *(optional)* |  | — |
| `STRIPE_WEBHOOK_EVENT_RETENTION_CRON` | — | — *(optional)* |  | — |
| `STRIPE_WEBHOOK_EVENT_RETENTION_DAYS` | — | `90` |  | — |
| `STRIPE_WEBHOOK_SECRET` | — | — *(optional)* |  | — |
| `STRIPE_WEBHOOK_TOLERANCE_SECONDS` | — | `150` |  | — |
| `TEAM_ORGANIZATION_ENABLED` | — | `true` |  | — |
| `TEST_MODE` | — | `false` |  | — |
| `TOMBSTONE_RETENTION_DAYS` | — | `90` |  | — |
| `TRUST_PROXY` | false \| 0, or integer 1–10 | `false` | ✓ | Number of reverse-proxy hops Fastify may trust for X-Forwarded-* headers. |
| `TRUST_PROXY_REQUIRED` | — | `true` |  | — |
| `UPLOAD_ALLOW_SVG` | — | `false` |  | — |
| `UPLOAD_MAX_PENDING_PER_ORGANIZATION` | — | `2000` |  | — |
| `UPLOAD_MAX_PENDING_PER_USER` | — | `100` |  | — |
| `UPLOAD_PENDING_SWEEP_CRON` | — | — *(optional)* |  | — |
| `UPLOAD_PENDING_SWEEP_GRACE_SECONDS` | — | `3600` |  | — |
| `UPLOAD_TOMBSTONE_RETENTION_CRON` | — | — *(optional)* |  | — |
| `UPLOAD_USE_PRESIGNED_POST` | — | `true` |  | — |
| `USER_DATA_EXPORT_RETENTION_CRON` | — | — *(optional)* |  | — |
| `USER_TOMBSTONE_RETENTION_CRON` | — | — *(optional)* |  | — |
| `WEBAUTHN_RP_ID` | — | — *(optional)* |  | — |
| `WEBAUTHN_RP_NAME` | — | — *(optional)* |  | — |
| `WEBHOOK_ALLOWLIST_REQUIRED` | — | `true` |  | — |
| `WEBHOOK_DELIVERY_ATTEMPT_RETENTION_CRON` | — | — *(optional)* |  | — |
| `WEBHOOK_DELIVERY_ATTEMPT_RETENTION_DAYS` | — | `30` |  | — |
| `WEBHOOK_MAX_PER_ORG` | — | `25` |  | — |
| `WEBHOOK_SECRET_ROTATION_OVERLAP_HOURS` | — | `24` |  | — |
| `WEBHOOK_TOMBSTONE_RETENTION_CRON` | — | — *(optional)* |  | — |
| `WEBHOOK_URL_ALLOWLIST` | — | — *(optional)* |  | — |
| `WORKER_CONCURRENCY` | — | `4` |  | — |
| `WORKER_CONCURRENCY_MAIL` | — | — *(optional)* |  | — |
| `WORKER_CONCURRENCY_NOTIFY` | — | — *(optional)* |  | — |
| `WORKER_CONCURRENCY_STRIPE` | — | — *(optional)* |  | — |
| `WORKER_CONCURRENCY_WEBHOOK` | — | — *(optional)* |  | — |
| `WORKER_HEALTH_PORT` | — | `9090` |  | — |
| `WORKER_HEALTH_STALL_TIMEOUT_MS` | — | `300000` |  | — |
| `WORKER_QUEUE_FAMILIES` | — | `all` |  | — |
