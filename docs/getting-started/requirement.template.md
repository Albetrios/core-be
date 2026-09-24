# Requirement intake form (core-be)

This is the **format** `/be-build-requirement` produces and builds from. You don't have to
fill it all — give `/be-build-requirement` a direct task and it **drafts the whole form,
including the section-9 file tree, for your review**, asks about anything it shouldn't
guess, and iterates on your changes before building. Or fill the form yourself and pass
it. Either way the final, approved document looks like the form below.

## How to fill it

- Prefer the draft-and-review flow: give a direct task, then review the form the AI
  proposes — **check the section-9 tree first** — and reply with any changes.
- In a drafted form, every value the AI inferred is tagged `[assumed]` and listed under
  "Assumptions I added" up top — review those first; confirming or editing one clears its tag.
- Keep the `## N.` headings exactly as written — they are the sections the build reads.
- Every field has an example on the next line starting with `# e.g.` — **replace the
  `<...>` placeholder with your value**; leave the `# e.g.` line as a guide or delete it.
- If a section truly doesn't apply, write `none`. Anything you mark `default` uses the
  **Default assumptions** in [`requirement-intake.md`](requirement-intake.md).
- `/be-build-requirement` is best-effort: for any field left as a `<...>` placeholder or
  ambiguous, it asks you once to fill it — it never guesses the data model, auth, or tenancy.

## The form (copy this)

```markdown
# Requirement: <one-line title>
# e.g. Organization invoices

## 1. Summary & placement
- Purpose: <what + why, 1–2 lines>
  # e.g. Let organization admins list and fetch their billing invoices.
- Domain / sub-domain: <domain> / <sub-domain> (new or existing)
  # e.g. billing / invoice (new sub-domain under the existing billing domain)
- Depends on / related: <other domains, services, or features | none>
  # e.g. reads tenancy.organization; no cross-domain writes

## 2. Data model
- Need tables? <yes/no>
  # e.g. yes
- Table(s): <snake_case plural name(s) | none>
  # e.g. invoices
- Columns: <name: type, notNull?, default?, unique?, FK?>  (use text, never varchar)
  # e.g. organization_id: bigint, notNull, FK organizations.id
  # e.g. amount_cents: bigint, notNull
  # e.g. currency: text, notNull, default 'usd'
  # e.g. status: text, notNull   (CHECK status in ('draft','open','paid','void'))
  # e.g. issued_at: timestamptz, notNull
- Public-id prefix: <short token>
  # e.g. inv   ->  external id looks like inv_a1b2c3d4e5f6g7h8i9j0k
- Relations / indexes: <FKs, composite/unique indexes | none>
  # e.g. index (organization_id, issued_at desc); unique (organization_id, number)
- Tenancy / soft-delete / audit: <organization-scoped? RLS? soft-delete? audit?>
  # e.g. organization-scoped, RLS on (USING + WITH CHECK app.current_organization_public_id) | soft-delete: no (immutable ledger) | audit: created_at only

## 3. Public API
- Endpoints: <METHOD /api/v1/<path> — purpose>  (snake_case semantic params like {invoice_id})
  # e.g. GET /api/v1/billing/invoices — list the org's invoices
  # e.g. GET /api/v1/billing/invoices/{invoice_id} — get one invoice
  # e.g. POST /api/v1/billing/invoices — create an invoice
- Auth per route: <public | authenticated | organization-permission:<code> | global-role:admin>
  # e.g. organization-permission:billing.read on GET, billing.write on POST
- Request body (snake_case + validation): <fields | none>
  # e.g. POST { amount_cents: integer > 0, currency: 'usd'|'eur', due_at?: ISO-8601 }
- Response (serialized; external id is `id`): <fields>
  # e.g. { id, amount_cents, currency, status, issued_at, created_at }
- Statuses / headers / pagination: <success + errors | headers | cursor?>
  # e.g. 200 list/get/create, 403 no-permission, 404 not-found, 422 missing X-Idempotency-Key | X-Idempotency-Key required on POST | cursor pagination on list

## 4. Business logic
- Service intent per operation: <what each operation does>
  # e.g. listInvoices({ organizationId, cursor }); getInvoice({ organizationId, invoiceId }); createInvoice({ organizationId, input })
- Transactions / cross-domain (via services, never repositories): <... | none>
  # e.g. createInvoice wraps the insert in withTransaction; reads billing.subscription service for the active plan
- Events / workers: <event, queue, payload, behavior | none>
  # e.g. on createInvoice, enqueue an outbound webhook delivery via the notify webhook path (webhook_delivery row + NOTIFY_EVENT.WEBHOOK_DELIVERY_REQUESTED on commit); queue invoice-delivery; payload { invoicePublicId, organizationPublicId }
- Idempotency / caching / rate limits: <which writes | none>
  # e.g. POST create is idempotencyRequired (X-Idempotency-Key); no caching; default rate limit

## 5. i18n
- Message keys + English copy (errors.* / success.*): <keys | none>
  # e.g. errors.invoice_not_found "Invoice not found."
  # e.g. success.invoice_created "Invoice created."

## 6. Seed data
- Reference rows (idempotent, minimal): <... | none>
  # e.g. none
- Bulk / faker rows: <... | none>
  # e.g. 20 invoices per seeded organization with random status and amount

## 7. Tests — which layers do you need? (yes/no; defaults in [])
- Unit (validators / serializers / pure services) [yes]: <cases>
  # e.g. yes — validator rejects amount_cents <= 0; serializer exposes id, hides internal pk
- Integration (repository ↔ DB) [yes if data model]: <cases | none>
  # e.g. yes — repo.listByOrganization returns only the org's rows, ordered by issued_at
- E2E (fastify.inject route tests) [yes]: <happy + edge cases>
  # e.g. list 200 paginated; get 200; another org's invoice 404; no permission 403; bad cursor 400
- Smoke (live pnpm verify:base after seed) [yes]: <endpoints to hit>
  # e.g. GET /api/v1/billing/invoices returns 200 with a seeded organization token
- Contract (Stripe / Resend / S3 via nock) [yes if external calls]: <... | none>
  # e.g. none — no outbound calls
- Chaos (Toxiproxy fault injection) [no]: <... | none>
  # e.g. none

## 8. Non-functionals
- Observability: <logs / metrics / sentry>
  # e.g. log invoice.created with organization_id; counter invoices_created_total
- Performance budget: <targets>
  # e.g. list p95 < 100ms at 10k invoices per organization
- Security: <tenant isolation / secrets / PII>
  # e.g. RLS enforces organization isolation; no PII beyond the organization link; amounts are not secrets

## 9. File structure & deliverables (the AI drafts this tree from your prompt — review it first)
src/domains/<domain>/
├── <domain>.routes.ts                         # + <resource> routes
├── <domain>.container.ts                      # + <resource> service wiring
├── __tests__/<domain>.test.ts                 # + <resource> e2e
└── sub-domains/<sub-domain>/
    ├── <sub-domain>.schema.ts
    ├── <sub-domain>.{repository, service, controller, dto, validator, serializer, types}.ts
    ├── <sub-domain>.overview.md
    ├── events/ queues/ workers/               # only if section 4 declares events/jobs
    ├── seed/{index, reference, bulk, faker}
    └── __tests__/{<sub-domain>.test.ts, unit/}
migrations/<timestamp>_<change>.sql
src/shared/locales/en/{errors, success}.json   # + your i18n keys
docs/builds/<date>-<feature>/{build-report, traceability, review, quality}.md
# see requirement.example.md for a fully drawn tree
```
