`src/domains/upload/`

# Upload

## Purpose

Two-phase S3-presigned upload + download flow. Clients request a presigned URL, upload directly to S3 (or any S3-compatible store), then call back to confirm the upload so the platform can persist the file metadata row. The domain works against AWS S3 in production and against any S3-compatible endpoint configured via env (`S3_*` variables) for development and self-hosting.

What it owns:

- The `uploads` table that records each file's S3 key, content-type, byte size, owner, and upload state.
- The presigned-POST + presigned-GET URL issuance, with TTLs aligned to `PRESIGNED_URL_EXPIRY_SECONDS` (15 min by default).
- The `POST /api/v1/uploads`, `GET /:publicId`, `POST /:publicId/confirm`, and `DELETE /:publicId` HTTP API.

What it does not own: anti-virus / malware scanning (handled outside the platform), CDN caching policy (edge config), or content-type validation beyond the MIME-prefix allowlist on the presign call.

## Key invariants

- **Two-phase commit**: a create-upload request first **reserves** a `pending` row (atomically, see quota invariant) and only then mints the presigned URL; the confirm call validates the upload landed in S3 (HEAD) and transitions the row to `uploaded`. A row stuck in `pending` past its presign TTL is GC-able by retention.
- **Magic-byte verification on confirm**: after HEAD, confirm reads the object's leading bytes and rejects mismatches against the declared `content_type` (closing the spoofed-content-type vector where S3 only echoes the client-declared type).
- **Atomic per-user PENDING quota**: the pending-count check and the row insert run in one transaction guarded by a per-user `pg_advisory_xact_lock`, before any presigned URL is issued. This makes the quota race-free — concurrent requests cannot all pass the count check and then over-mint presigned slots. If presigning fails after the row is reserved, the row is left `pending` for the sweep worker to reclaim.
- **Reservation RLS context matches the row** (sec-r7/M4): an org-scoped upload reserves its `pending` row under `withPrincipalDatabaseContext` with an org scope (sets `app.current_organization_id`) so the `uploads_tenant_isolation` `WITH CHECK` is satisfied; a personal upload (`organization_id IS NULL`) reserves under `withPrincipalDatabaseContext` with a user scope for `uploads_owner_access`. Reserving an org row under user context is rejected by RLS as the production `core_be_app` role (FORCE RLS) — verified in `src/tests/security/rls/upload-rls.security.test.ts`.
- **Owner-scoped**: personal uploads (`organization_id IS NULL`) are owned by the presigning user. Org-scoped uploads require current `upload:manage` on get/confirm/delete — former members cannot mutate org assets via the user-owned upload routes.
- **Public-id only at the API boundary**: clients never see the internal numeric id; URLs use the URL-safe public id.
- **No server-side body proxying**: the API never sees the upload bytes — they go directly from client to S3. This is what makes the domain horizontally scalable.

## Sub-domains

`upload` is a flat domain — no `sub-domains/` folder. The single resource lives at the domain root. Per-symbol docs are in TSDoc on each export (use IDE hover or `pnpm tsdoc:check --report`).

## Patterns used

This domain implements the contracts documented in [src/PATTERNS.md](src/PATTERNS.md):

- `idempotency` — the presign + confirm endpoints accept `X-Idempotency-Key` so retries don't issue duplicate presigns or re-confirm a row.
- `soft-delete` — upload rows tombstone with `deleted_at`; a retention worker purges the S3 object and the row after the retention window.
- `audit-emission` — confirm and delete record audit rows so file lifecycle is forensically traceable.

## Cross-domain flows

The upload domain is consumed by other domains rather than driving any flow itself. Notable consumers:

- `user-data-export` (in [user/sub-domains/user-data-export/](src/domains/user/sub-domains/user-data-export/)) presigns the download URL for the GDPR export bundle.
- Any future `attachments` feature on notifications or invitations would also flow through this domain.

## External integrations

- **S3 (or S3-compatible)** — production targets AWS S3 directly. `S3_ENDPOINT` is set for non-AWS providers (MinIO, R2, etc.). Requests use the AWS SDK v3 with SigV4.

## Failure modes

- **Confirm before upload landed** → S3 HEAD fails; row stays `pending`; client must retry the upload then the confirm.
- **Confirm of a row that doesn't belong to the caller** → 404 (we deliberately don't reveal existence).
- **Presign TTL exceeded** → S3 rejects the upload with a SignatureDoesNotMatch / ExpiredToken response; client must request a fresh presign.
- **Delete after S3 outage** → DB row tombstones; retention worker retries the S3 object delete on its next pass.
