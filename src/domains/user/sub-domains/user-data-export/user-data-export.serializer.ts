import type {
  UserDataExportOutput,
  UserDataExportRow,
} from '@/domains/user/sub-domains/user-data-export/user-data-export.types.js';

/**
 * Project a `user_data_exports` row into the public {@link UserDataExportOutput} shape.
 * The presigned `download_url` is supplied by the caller (the service mints it only when COMPLETED
 * and not yet past `expires_at`); timestamps are emitted as ISO-8601 strings.
 */
export function serializeUserDataExport(
  row: UserDataExportRow,
  options?: { download_url?: string | null },
): UserDataExportOutput {
  return {
    id: row.public_id,
    status: row.status as UserDataExportOutput['status'],
    download_url: options?.download_url ?? null,
    expires_at: row.expires_at?.toISOString() ?? null,
    completed_at: row.completed_at?.toISOString() ?? null,
    failed_at: row.failed_at?.toISOString() ?? null,
    error_code: row.error_code,
    created_at: row.created_at.toISOString(),
  };
}
