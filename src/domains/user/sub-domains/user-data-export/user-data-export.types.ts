import type { user_data_exports } from './user-data-export.schema.js';

/** Thrown when an export job should stop without retry (user deleted or export row removed). */
export class UserDataExportCancelledError extends Error {
  constructor(message = 'User data export cancelled') {
    super(message);
    this.name = 'UserDataExportCancelledError';
  }
}

/**
 * Lifecycle codes persisted in `user_data_exports.status`. Values match the DB CHECK constraint:
 * `pending` → `processing` → (`completed` | `failed`). Used by the worker, retention job, and API responses.
 */
export const USER_DATA_EXPORT_STATUSES = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

/** String literal union derived from {@link USER_DATA_EXPORT_STATUSES}. */
export type UserDataExportStatus =
  (typeof USER_DATA_EXPORT_STATUSES)[keyof typeof USER_DATA_EXPORT_STATUSES];

/** Drizzle-inferred select row from the `auth.user_data_exports` table. */
export type UserDataExportRow = typeof user_data_exports.$inferSelect;

/**
 * Aggregated GDPR export payload — the exact JSON shape gzipped and uploaded to S3.
 * Cross-domain projections from users, memberships, sessions, notifications, and audit logs.
 */
export interface UserDataExport {
  user: {
    id: string;
    email: string;
    full_name: string | null;
    created_at: string;
  };
  organizations: {
    name: string;
    slug: string | null;
    role: string;
    joined_at: string;
  }[];
  sessions: {
    ip_address: string | null;
    last_active_at: string;
    created_at: string;
  }[];
  notifications: {
    type: string;
    title: string;
    message: string;
    created_at: string;
  }[];
  audit_activity: {
    action: string;
    resource_type: string;
    created_at: string;
  }[];
  /**
   * Disclosure of any per-category row caps hit while building this export. When
   * `truncated_categories` is non-empty the listed sections contain only the most
   * recent `row_cap` rows, so the data subject knows the export is not exhaustive.
   */
  truncation: {
    row_cap: number;
    truncated_categories: string[];
  };
  exported_at: string;
}

/** API response shape for export status queries; the `download_url` is presigned and only set when COMPLETED and not yet expired. */
export type UserDataExportOutput = {
  id: string;
  status: UserDataExportStatus;
  download_url: string | null;
  expires_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  error_code: string | null;
  created_at: string;
};
