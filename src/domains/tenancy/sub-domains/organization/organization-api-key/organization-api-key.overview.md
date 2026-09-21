`src/domains/tenancy/sub-domains/organization/organization-api-key/`

# Organization API keys (nested resource)

Parent: [organization](../organization.overview.md)

## Purpose

Lifecycle service for organization-scoped API keys — create, list, rotate, revoke, and authenticate-by-prefix (the `X-Api-Key` middleware resolves keys through this sub-domain).

## Layout

- `organization-api-key.controller.ts` / `organization-api-key.service.ts` — thin HTTP + application layer (create/rotate/revoke/authenticate)
- `organization-api-key.repository.ts` / `organization-api-key.schema.ts` — persistence (hash + display prefix, soft-delete)
- `organization-api-key.dto.ts` / `organization-api-key.validator.ts` / `organization-api-key.serializer.ts` / `organization-api-key.types.ts` — request/response shaping
- `workers/` — tombstone-retention worker (hard-deletes soft-deleted keys after the retention window)
- `seed/` — seed contribution
- `__tests__/unit/` — service/validator/serializer/worker unit suites

## Key invariants

- The raw secret (`ak_…`, 32 random bytes) is returned **once** at create/rotate; only its `sha256` hash is stored, with an 8-char display prefix for identification — there is no way to re-read a secret.
- Key scopes are constrained by the caller's own grants: `assertCallerCanGrantPermissionCodes` rejects granting permission codes the caller cannot grant.
- Revocation is soft-delete; hard deletion happens only via the tombstone-retention worker in `workers/`.
- **Authentication itself is never cached.** Every request re-resolves the key against Postgres, so a revoked, expired or deleted-organization key stops working on the very next request rather than at the end of some window. What *is* throttled is the `last_used_at` write: a Redis `SET … NX` claim (`organization-api-key-last-used.throttle.ts`) lets one request per key per minute open the transaction that records it, because that transaction was the only one an authenticated API-key request opened and the `UPDATE` inside it was already a no-op for almost all of them. The claim is never read back — it gates a write, it does not answer a question — which is what keeps it out of the authentication decision.

## Lifecycle

```mermaid
stateDiagram-v2
    [*] --> active: create (raw secret shown once)
    active --> active: rotate (new secret, old hash replaced)
    active --> revoked: revoke (soft-delete)
    revoked --> [*]: tombstone-retention worker hard-delete
```
