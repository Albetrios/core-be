import { sql } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';

/**
 * Postgres advisory-lock namespaces (`classid`) for per-scope resource-creation quotas (audit-#8).
 *
 * @remarks
 * Each value is a distinct ASCII tag so the two-key `pg_advisory_xact_lock(classid, objid)` form
 * keeps every resource type in its own lock space (and never collides with single-key advisory
 * locks like the migration runner). The `objid` is a positive int4 hash of the scope id — the
 * owning user for the owned-organization cap, the organization for the per-organization caps. Only
 * stability matters (the same scope must always map to the same lock).
 */
export const RESOURCE_QUOTA_LOCK_NAMESPACE = {
  /** Owned-TEAM-organization cap, keyed by owner user id. ASCII `OWNO`. */
  OWNED_ORGANIZATION: 0x4f_57_4e_4f,
  /** Organization API-key cap, keyed by organization id. ASCII `APIK`. */
  ORGANIZATION_API_KEY: 0x41_50_49_4b,
  /** Custom member-role cap, keyed by organization id. ASCII `ROLE`. */
  MEMBER_ROLE: 0x52_4f_4c_45,
  /** Plan seat cap on member-add, keyed by organization id. ASCII `SEAT`. */
  MEMBERSHIP_SEAT: 0x53_45_41_54,
  /** Organization notification-policy cap, keyed by organization id. ASCII `NPOL`. */
  ORGANIZATION_NOTIFICATION_POLICY: 0x4e_50_4f_4c,
  /** Organization webhook cap, keyed by organization id. ASCII `WHKS`. */
  WEBHOOK: 0x57_48_4b_53,
  /** Per-user WebAuthn-credential cap, keyed by user id. ASCII `WBAN`. */
  WEBAUTHN_CREDENTIAL: 0x57_42_41_4e,
  /** Per-user concurrent active-session cap, keyed by user id. ASCII `SESN`. */
  AUTH_SESSION: 0x53_45_53_4e,
  /** Per-organization pending member-invitation cap, keyed by organization id. ASCII `INVT`. */
  MEMBER_INVITATION: 0x49_4e_56_54,
} as const;

/**
 * Takes a transaction-scoped advisory lock that serializes resource-creation quota checks for one
 * scope (audit-#8).
 *
 * @remarks
 * - **Algorithm:** `pg_advisory_xact_lock(namespace, objid)` on the request-scoped connection; the
 *   lock auto-releases at COMMIT/ROLLBACK. MUST be acquired inside the same transaction as the
 *   subsequent `count(...) >= cap` check and the insert (e.g. within `withPrincipalDatabaseContext`).
 *   The `objid` is `hashtextextended(key) & 0x7fffffff` — a stable positive int4 hash of the scope
 *   id, so `bigserial` keys beyond int4's 2.1B max can never overflow the int4 `objid` (B-1). A hash
 *   collision only causes harmless extra contention; the count is still independently scope-filtered.
 * - **Failure modes:** blocks until the lock is granted; no application-level timeout (the
 *   surrounding statement timeout bounds it).
 * - **Side effects:** holds a Postgres advisory lock for the remainder of the transaction.
 * - **Notes:** closes the count-then-insert race where concurrent create requests each pass the
 *   same pre-check before any row is inserted and overshoot the configured cap.
 */
export async function acquireResourceQuotaLock(namespace: number, key: number): Promise<void> {
  await getRequestDatabase().execute(
    sql`SELECT pg_advisory_xact_lock(${namespace}::int, (hashtextextended(${key}::text, 0) & 2147483647::bigint)::int)`,
  );
}
