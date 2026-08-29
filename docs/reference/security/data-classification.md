# Data classification (GDPR-oriented)

High-level classification of sensitive fields for retention, export, and access reviews. Complements [data-lifecycle-deletion.md](../data/data-lifecycle-deletion.md) and [user-data-export.md](../data/user-data-export.md).

| Class                       | Examples in core-be                                           | Handling                                           |
| --------------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| **Identity (PII)**          | `auth.users.email`, profile names, OAuth subject ids          | Authenticated access; included in user data export |
| **Authentication secrets**  | Password hashes, MFA secrets, session rows, API key hashes    | Never returned by API; short TTL or hard delete    |
| **Billing** | Stripe customer ids on subscriptions | Tenant RLS; minimal exposure in serializers — see [billing-database-schema.md](../data/billing-database-schema.md) |
| **Operational metadata**    | IP in audit logs, `request_id` in API meta                    | Retention workers; audit purge cron                |
| **Webhook secrets**         | `notify.webhooks.encrypted_secret`                            | Encrypted at rest; organization-scoped RLS                  |
| **System ingress**          | `billing.stripe_webhook_events` (event ids only)              | No tenant RLS; no full Stripe payload stored       |

When adding columns that hold email, phone, government ids, or payment instrument details, update this table and confirm export/retention behavior.

## Related

- [`src/PATTERNS.md`](../../../src/PATTERNS.md) § Tenant Isolation, § Soft Delete — how PII is partitioned and how soft-delete preserves history
- [`src/POLICIES.md`](../../../src/POLICIES.md) — retention windows, GDPR export caps, session lifetimes
- [`src/domains/user/sub-domains/user-data-export/user-data-export.overview.md`](../../../src/domains/user/sub-domains/user-data-export/user-data-export.overview.md) — GDPR export pipeline invariants
