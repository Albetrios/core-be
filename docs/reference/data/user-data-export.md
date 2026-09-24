# User data export (GDPR)

Async export of personal data to S3 with time-limited presigned download URLs.

## Flow

1. `POST /api/v1/users/me/data-export` — creates `auth.user_data_exports` row (`pending`), enqueues BullMQ job, returns **200** with the export's `id` and `status` (the method-status policy answers every successful POST with 200).
2. Worker aggregates cross-domain data, writes `user-data-export/{userPublicId}/{data_export_id}.json.gz` to S3.
3. `GET /api/v1/users/me/data-export/{data_export_id}` — returns status; when `completed`, includes presigned GET URL (≤24h).

## Retention and privacy

| Control | Value |
| ------- | ----- |
| Presigned download URL | ≤24h (`USER_DATA_EXPORT_PRESIGNED_DOWNLOAD_EXPIRY_SECONDS`) |
| Row `expires_at` | 7 days (`USER_DATA_EXPORT_ARTIFACT_TTL_DAYS`) |
| S3 lifecycle | Bucket rule on prefix `user-data-export/` — expire objects after **7 days** (applied at bucket provisioning time via `PutBucketLifecycleConfiguration`) |
| Expired row purge | Daily BullMQ `user-data-export-retention` worker deletes S3 objects + DB rows where `expires_at` has passed |
| Account deletion | `UserService` offboarding calls `deleteAllExportsForUser` (S3 `deleteObject` + DB rows) immediately on `DELETE /users/me` |

## Workers

- **Export build:** queue `user-data-export` — processor `workers/user-data-export.processor.ts`
- **Retention:** queue `user-data-export-retention` — processor `workers/user-data-export-retention.processor.ts` (cron `44 5 * * *` UTC by default, registered in `scheduler.ts`)
- Both registered in `src/infrastructure/queue/bootstrap.ts`

Export jobs exit without retry when the user is soft-deleted or the export row was removed during offboarding (`UserDataExportCancelledError`).

See [data-classification.md](../security/data-classification.md) and [data-lifecycle-deletion.md](../data/data-lifecycle-deletion.md).

## Related

- [`src/domains/user/sub-domains/user-data-export/user-data-export.overview.md`](../../../src/domains/user/sub-domains/user-data-export/user-data-export.overview.md) — sub-domain invariants, cross-domain service wiring, failure modes
- [`src/POLICIES.md`](../../../src/POLICIES.md) — `USER_DATA_EXPORT_*` policy constants and rationale
- [`src/FLOWS.md`](../../../src/FLOWS.md) § GDPR export — end-to-end flow diagram
