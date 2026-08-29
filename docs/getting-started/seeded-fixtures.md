# Seeded fixtures (`pnpm db:seed:full`)

The **full** seed (`src/scripts/seed/full.ts`) extends the minimal seed with demo tenancy flows plus billing, notify, usage, and audit data for local exploration and API smoke tests.

## Credentials

| Field | Value |
| ----- | ----- |
| Email | `demo@example.com` |
| Password | `TEST_PASSWORD` from `.env`, or a generated value logged on first run |

## Demo organization

| Field | Value |
| ----- | ----- |
| Name | Demo Organization |
| Slug | `demo-org` |
| Role | Admin (all system permissions) |

## Billing fixtures

After `pnpm db:seed:full`:

- **Plans** — Free, Starter, Pro (from `plan.seed.ts`)
- **Subscription** — Active monthly subscription on the demo organization (Starter plan)
- **Usage records** — API requests and storage metrics for the subscription period
- **Entitlements** — `api_calls` and `storage_gb` feature flags on the demo organization

Use the organization id (`org_…`) from seed logs when switching the active organization (`POST /auth/switch-to-organization`) for billing routes.

## Notify fixtures

- **Notifications** — Welcome and billing-paid in-app messages for the demo user
- **Webhook** — Disabled-by-default style endpoint URL (`https://example.com/webhooks/demo`) registered for billing events such as `billing.subscription.updated` (secret is encrypted at rest)

## Audit fixtures

- Sample **audit.logs** rows for organization create and membership invite actions (actor = demo user)

## Commands

```bash
pnpm compose:up && pnpm compose:wait
pnpm db:migrate
pnpm db:seed:full
pnpm dev
```

For the minimal reference data only (permissions + plans), use `pnpm db:seed`.
