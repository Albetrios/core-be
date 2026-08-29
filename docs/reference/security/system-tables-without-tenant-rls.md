# System tables without tenant RLS

Some Postgres tables are **intentionally not** protected by organization-scoped row-level security (RLS). They are accessed only from workers, migrations, or tightly scoped application code — never exposed via tenant HTTP routes.

---

## Tables

| Schema / table | Purpose | Access pattern |
| -------------- | ------- | -------------- |
| `billing.stripe_webhook_events` | Stripe webhook idempotency ledger | Stripe webhook worker + `StripeWebhookEventRepository`; scoped by `stripe_event_id` |
| `auth.mail_outbox` (see migration `20260516000007_mail_outbox.sql`) | Transactional mail outbox | Mail worker; enqueue from domain handlers |

Migration headers document the no-RLS decision (e.g. [`20260517000003_stripe_webhook_events_and_subscription_monotonic.sql`](../../../migrations/00000000000000_init.sql)).

---

## Defense in depth (RLS)

Migration [`20260520000001_system_tables_rls_deny_all.sql`](../../../migrations/20260520000001_system_tables_rls_deny_all.sql) enables **FORCE RLS** with:

- **`deny_all` policy** on `PUBLIC` — blocks accidental access without a role grant
- **`core_be_app` policy** — allows the application role used by API/worker connections

Tenant isolation still relies on application query boundaries; these policies prevent cross-table leaks if a connection uses the wrong role.

## Invariants

1. **No HTTP routes** return raw rows from these tables.
2. Workers pass explicit identifiers (`organizationId`, event ids) in repository queries — do not rely on `app.current_organization_public_id`.
3. Application DB role (`core_be_app`) should have **minimal** privileges on these tables (insert/update/select only where required).

---

## Related

- Tenant RLS overview: [domains-and-public-api-design.md](../architecture/domains-and-public-api-design.md)
- Production audit: [production-audit-2026-05-18.md](../../reviews/production-audit-2026-05-18.md) (system tables section)
- [`src/PATTERNS.md`](../../../src/PATTERNS.md) § Tenant Isolation, § RLS Context — how the `app.current_organization_public_id` GUC is set and the four RLS context wrappers
- [`src/infrastructure/database/database.overview.md`](../../../src/infrastructure/database/database.overview.md) — context family, force-RLS table list, connection budget
