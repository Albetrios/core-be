# Requirement example — Organization invoices (core-be)

A complete, filled-in copy of [`requirement.template.md`](requirement.template.md) — what
a ready-to-build requirement looks like with every `<...>` replaced. Study it, or copy the
block and run it with `/be-build-requirement` (bring Postgres + Redis up for the live smoke).

This is the *approved* shape. When `/be-build-requirement` drafts a requirement from a short
prompt, every value it inferred is tagged `[assumed]` and gathered in an "Assumptions I
added" list up top, so you can change them before the document is finalized like this.

```markdown
# Requirement: Organization invoices

## 1. Summary & placement
- Purpose: Let organization admins list, fetch, and create their billing invoices.
- Domain / sub-domain: billing / invoice (new sub-domain under the existing billing domain)
- Depends on / related: reads tenancy.organization; no cross-domain writes

## 2. Data model
- Need tables? yes
- Table(s): invoices
- Columns:
  - organization_id: bigint, notNull, FK organizations.id
  - number: text, notNull (per-organization sequence)
  - amount_cents: bigint, notNull
  - currency: text, notNull, default 'usd'
  - status: text, notNull (CHECK status in ('draft','open','paid','void'))
  - issued_at: timestamptz, notNull
- Public-id prefix: inv
- Relations / indexes: index (organization_id, issued_at desc); unique (organization_id, number)
- Tenancy / soft-delete / audit: organization-scoped, RLS on (USING + WITH CHECK app.current_organization_public_id) | soft-delete: no (immutable ledger) | audit: created_at, updated_at

## 3. Public API
- Endpoints:
  - GET /api/v1/billing/invoices — list the org's invoices
  - GET /api/v1/billing/invoices/{invoice_id} — get one invoice
  - POST /api/v1/billing/invoices — create an invoice
- Auth per route: organization-permission:billing.read on GET; organization-permission:billing.write on POST
- Request body: POST { amount_cents: integer > 0, currency: 'usd'|'eur', due_at?: ISO-8601 }
- Response: { id, number, amount_cents, currency, status, issued_at, created_at }
- Statuses / headers / pagination: 200 list/get/create, 403 no-permission, 404 not-found, 422 missing X-Idempotency-Key | X-Idempotency-Key required on POST | cursor pagination on list

## 4. Business logic
- Service intent per operation: listInvoices({ organizationId, cursor }); getInvoice({ organizationId, invoiceId }); createInvoice({ organizationId, input })
- Transactions / cross-domain: createInvoice wraps the insert in withTransaction and allocates the next per-organization number; reads billing.subscription service for the active plan
- Events / workers: on createInvoice, enqueue an outbound webhook delivery via the notify webhook path (write a webhook_delivery row + emit NOTIFY_EVENT.WEBHOOK_DELIVERY_REQUESTED on commit); queue invoice-delivery; payload { invoicePublicId, organizationPublicId }
- Idempotency / caching / rate limits: POST create is idempotencyRequired (X-Idempotency-Key); no caching; default rate limit

## 5. i18n
- Message keys + English copy:
  - errors.invoice_not_found "Invoice not found."
  - errors.invoice_amount_invalid "Invoice amount must be greater than zero."
  - success.invoice_created "Invoice created."

## 6. Seed data
- Reference rows: none
- Bulk / faker rows: 20 invoices per seeded organization with random status and amount

## 7. Tests
- Unit: yes — validator rejects amount_cents <= 0 and unknown currency; serializer exposes id and hides the internal pk
- Integration: yes — repository.listByOrganization returns only the org's rows ordered by issued_at desc; create allocates a unique per-organization number
- E2E: list 200 paginated; get 200; another org's invoice 404 (tenant boundary); no permission 403; missing X-Idempotency-Key 422; bad cursor 400
- Smoke: GET /api/v1/billing/invoices returns 200 with a seeded organization token after pnpm verify:base
- Contract: none (no outbound calls)
- Chaos: none

## 8. Non-functionals
- Observability: log invoice.created with organization_id; counter invoices_created_total
- Performance budget: list p95 < 100ms at 10k invoices per organization
- Security: RLS enforces organization isolation; amounts are not secrets; no PII beyond the organization link

## 9. File structure & deliverables (drafted as a tree for review first)
src/domains/billing/
├── billing.routes.ts                          # + invoice routes
├── billing.container.ts                       # + invoice service wiring
├── __tests__/billing.test.ts                  # + invoice e2e cases
└── sub-domains/invoice/
    ├── invoice.schema.ts
    ├── invoice.repository.ts
    ├── invoice.service.ts
    ├── invoice.controller.ts
    ├── invoice.dto.ts
    ├── invoice.validator.ts
    ├── invoice.serializer.ts
    ├── invoice.types.ts
    ├── invoice.overview.md
    ├── events/invoice-created-emit.ts
    ├── queues/invoice-delivery.queue.ts
    ├── workers/invoice-delivery.worker.ts
    ├── seed/{index, invoice.reference.seed, invoice.bulk.seed, invoice.faker}.ts
    └── __tests__/
        ├── invoice.test.ts
        └── unit/{invoice.validator, invoice.serializer}.unit.test.ts
migrations/<timestamp>_create_invoices.sql
src/shared/locales/en/{errors, success}.json   # + invoice_not_found / invoice_amount_invalid / invoice_created
docs/builds/<date>-organization-invoices/{build-report, traceability, review, quality}.md
```
