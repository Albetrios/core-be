# core-fe API coverage — what `fe-full-journey.js` walks, and what it misses

This scenario is driven by the **front end**, not by the backend's route catalogue. Every call was
extracted from `core-fe/src` by resolving each `apiClient.<verb>(...)` template against the path
constants it interpolates (`AUTH_API`, `ORG_API`, `BILLING_API`, `NOTIF_API`, `MFA_API`,
`SESSIONS_API`, `WEBAUTHN_API`, `PREFS_API`, `WEBHOOKS_API`, `INVITATIONS_API`) plus the
`API_ENDPOINTS.AUTH` map in `core-fe/src/core/config/constants.ts`. If the app does not call it, it
is not in the script — even where the backend exposes it.

| | |
|---|---:|
| Distinct core-fe API calls | **67** |
| Walked by the script | **48** (45 default + 3 behind `STEP_UP=true`) |
| Cannot be walked | **19** |

```bash
BASE_URL=http://localhost:4985 VUS=1 k6 run src/tests/load/k6/scenarios/fe-full-journey.js
```

Clear the board before each run so the numbers describe one run only:

```bash
curl -s -X POST http://localhost:4985/__monitor/clear
```

## The 19 calls the script cannot make

Grouped by cause, because the cause is what you would have to change to reach them.

### Needs a password — 4

No seeded user has one: `password_hash` is null for every row in `auth.users`.

| Method | Call |
|---|---|
| `POST` | `/auth/login` |
| `POST` | `/auth/password/change` |
| `POST` | `/auth/password/forgot` |
| `POST` | `/auth/password/reset` |

### Needs a real authenticator or an enrolled factor — 5

| Method | Call | Why |
|---|---|---|
| `POST` | `/auth/me/mfa/enroll/confirm` | Needs a TOTP code computed from the staged secret |
| `POST` | `/auth/me/mfa/verify` | Needs a confirmed factor |
| `DELETE` | `/auth/me/mfa/:id` | Enrolment stages the secret in Redis — no method row exists until `confirm` succeeds |
| `POST` | `/auth/me/webauthn/register/verify` | Needs a device to sign the challenge |
| `DELETE` | `/auth/me/webauthn/credentials/:id` | Needs a registered credential, which needs the verify above |

### Blocked by the step-up factor rule — 1

| Method | Call |
|---|---|
| `DELETE` | `/auth/me/sessions/:id` |

The API states the rule outright:

> *This action requires a recent step-up with your password or MFA; an email-code step-up is not
> sufficient.*

The script **can** reach `POST /auth/step-up` with an email code (see below), but this route
specifically refuses that factor, and pool users have neither a password nor MFA.

### Reaches Stripe — 6

| Method | Call |
|---|---|
| `POST` | `/billing/subscriptions` |
| `POST` | `/billing/payment-methods/setup` |
| `POST` | `/billing/subscriptions/:id/cancel` |
| `POST` | `/billing/subscriptions/:id/change-plan` |
| `POST` | `/billing/subscriptions/:id/resume` |
| `GET` | `/billing/subscriptions/:id/payment-setup` |

Verified rather than assumed: `POST /billing/subscriptions` answers **503** with no Stripe
reachable. The last four also need a subscription to exist, and the first is the only way to make one.

### No role grants the permission — 2

| Method | Call |
|---|---|
| `POST` | `/notify/webhooks` |
| `DELETE` | `/notify/webhooks/:id` |

An Owner holds 14 permissions; `webhook:read` and `webhook:manage` are not among them, and no role
in the system grants them. These answer **403 for every caller**, not just pool users.

### Needs data nothing in the flow creates — 1

| Method | Call |
|---|---|
| `PATCH` | `/notify/notifications/:id/read` |

There is no route that creates a notification, and no action in this journey generates one.

### Needs the emailed token — 1

| Method | Call |
|---|---|
| `POST` | `/tenancy/invitations/:id/accept` |

The raw invitation token exists only in the email body; the serializer never exposes it. This also
blocks `transfer-ownership`, which requires an **active** member.

### Excluded by choice — 1

| Method | Call |
|---|---|
| `POST` | `/auth/refresh` |

It works, but is capped at **30/min per IP**. Every virtual user shares one IP locally, so including
it exhausts the budget and fails the run — the defect that broke the earlier front-end journey.

## Responses that would otherwise come back empty

A `200` on an empty list proves the endpoint answered, not that it returns what you expect. These
now carry real rows, each with a content check so a silently-empty response fails instead of passing
on the status code alone:

| Call | Empty by default | What the script does |
|---|---|---|
| `PUT /users/me/notification-preferences` | yes | Writes one real preference, asserts it comes back, then restores the original |
| `GET /tenancy/organization/api-keys` | yes | Lists *after* the create, and asserts the new key is in the list |
| `GET /tenancy/organization/memberships` | owner only | Re-read after the invite; asserts the invitee appears |
| `GET /auth/me/auth-methods` | no | Asserts the email-code method the sign-in produced is present |
| `GET /auth/me/sessions` | no | Asserts the session making the call is listed |

`GET /billing/plans` returns rows once `pnpm db:seed` has run (Free / Starter / Pro).

### Still empty, and why

| Call | Reason |
|---|---|
| `GET /notify/notifications` | No route creates a notification and nothing in the flow generates one |
| `GET /billing/subscriptions` | Creating one is a Stripe call |
| `GET /billing/invoices` | Needs a subscription to bill |
| `GET /billing/payment-methods` | Attaching one is a Stripe call |
| `GET /auth/me/mfa` | Enrolment stages in Redis; the list stays empty until `confirm`, which needs a TOTP code |
| `GET /auth/me/webauthn/credentials` | Needs a registered passkey |

## The seat limit — why the member routes may skip

Whether steps 36–38 run depends on the plan catalogue, and the script adapts to both states.

With **no plans seeded**, no seat ceiling applies and the invite succeeds, so the member routes run
end to end. With the **catalogue seeded**, a new organization lands on **Free, which allows exactly
one seat** — the owner is already the whole allowance:

```
409 seat_limit_reached — Your plan's seat limit (1) has been reached.
```

Raising it means subscribing to Starter (5 seats) or Pro (25), which is the Stripe call above.

The script reads the ceiling from `GET /billing/plans` at step 03 — the cheapest active plan's
`limits.seats`, matching the backend's own `getFreePlanSeatCeiling()` — and **skips 36–38 rather
than firing a request it knows will 409**. The summary states which case you are looking at:

```
member invite    refused for 1 VU(s) — Free plan allows 1 seat; steps 37-38 need Starter/Pro, a Stripe call
```

## How the harder routes were reached

Three things that looked impossible at first:

1. **The member routes.** `POST /tenancy/organization/memberships` writes the invitation to the
   transactional outbox and enqueues a job — **the Resend call happens in the mail worker, never in
   the request** — so inviting touches Postgres and Redis only. The invitee is an existing pool user
   rather than a new signup, so no account rows accumulate.

2. **The step-up cluster.** `TEST_MODE` returns the real verification code on `send-code`
   (`debug_verification_code`), and `POST /auth/step-up` accepts it. A code is issued at most once
   per 60 seconds per email and sign-in consumes the first, so reaching step-up costs one 60-second
   wait — per VU, in parallel, so about a minute of wall clock for the whole run. That is
   `STEP_UP=true`, which adds `step-up`, `mfa/enroll` and `webauthn/register/options`.

3. **Self-service signup.** `send-code` + `login` on an unknown email creates an ACTIVE, verified
   user. The script does not rely on this — it uses pool users so nothing accumulates — but it is
   how a second identity could be produced if one were ever needed.

## Self-cleaning

Each VU creates its own TEAM organization, works inside it, and deletes it. Step 47 re-reads
`me/context` and requires the organization to be gone from the owner's own list — the proof runs
inside the session, under the user's own token and RLS context, rather than against the database.

Measured across runs: **organizations delta 0, users delta 0**.

One row count moves the first time you run against untouched pool users, and it is not a leak: the
platform provisions a user's **personal** organization lazily on their first ever login. It is one
per account, permanent, excluded from the TEAM quota, and it cascade-deletes with the user — a real
signup creates it too.

`DELETE /organization` is capped at 5 per 5 minutes per user, so replaying the same users inside
that window throttles the teardown. Roll along the pool instead of waiting:

```bash
BASE_URL=http://localhost:4985 VUS=20 USER_OFFSET=20 k6 run src/tests/load/k6/scenarios/fe-full-journey.js
```
