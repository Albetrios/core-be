`src/infrastructure/storage/`

# Storage infrastructure

## Purpose

S3-compatible object storage client. Owns the AWS SDK v3 client instance, presigned URL issuance for uploads + downloads, and HEAD-object validation for the upload-confirm flow. Used by [upload](src/domains/upload/) and [user-data-export](src/domains/user/sub-domains/user-data-export/).

## Design decisions

- **AWS SDK v3 over v2**: smaller bundle, modern promise-based API, native `@aws-sdk/s3-request-presigner` for presigned URLs.
- **S3-compatible by default**: `S3_ENDPOINT` env lets ops point at MinIO, R2, or any S3-compatible service. Production uses AWS S3 directly.
- **Presigned URLs for both upload and download**: we never proxy bytes through the API process. Upload uses `createPresignedPost` (browser-friendly form fields); download uses `getSignedUrl` for the GET.
- **Per-call timeouts** on HEAD-object so the upload-confirm flow can't hang on a slow S3 region.
- **No PII in object keys**: keys are deterministic from public ids; never include email or organization slug.

## Operational concerns

- **Presigned URL TTL**: aligned with `PRESIGNED_URL_EXPIRY_SECONDS = 900` (15 min) for upload presigns; 24 h for GDPR export downloads.
- **Region pinning**: `S3_REGION` env. Cross-region transfers should not happen in normal operation.
- **CORS configuration on the bucket** must permit the platform's origin and the presigned-POST headers. Documented in setup runbooks.
- **Signed URLs and SigV4**: AWS caps presigned URL TTL at 7 days for SigV4 signers; the platform runs at much shorter TTLs.

## External dependencies

- **AWS S3** (or S3-compatible).

## Tuning parameters

- `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` (for non-AWS endpoints).
- `PRESIGNED_URL_EXPIRY_SECONDS = 900`.
- `USER_DATA_EXPORT_PRESIGNED_DOWNLOAD_EXPIRY_SECONDS = 86 400`.

## Failure modes

- **HEAD on missing object** → 404 (handled at confirm time → "upload not landed").
- **Bucket misconfigured for CORS** → presigned upload from a browser fails; not visible in our logs (it's a browser-side error).
- **Region outage** → presign succeeds (no network call) but the upload itself fails; client retries; the platform is unaffected because the row stays `pending`.
