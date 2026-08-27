import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import {
  RESOURCE_QUOTA_LOCK_NAMESPACE,
  acquireResourceQuotaLock,
} from '@/infrastructure/database/resource-quota-lock.util.js';
import { databaseNowTimestamp } from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { DEFAULT_REPOSITORY_LIST_LIMIT } from '@/shared/constants/query-limits.constants.js';
import { capListWithWarning } from '@/shared/utils/infrastructure/list-cap.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { webauthn_credentials } from './webauthn-credential.schema.js';

/** Drizzle row type inferred from {@link webauthn_credentials}; used by the WebAuthn service when reading stored passkeys. */
export type WebauthnCredentialRow = typeof webauthn_credentials.$inferSelect;

/**
 * Drizzle repository for {@link webauthn_credentials}; tracks signature counter monotonicity via
 * {@link updateCounter} and revokes via `revoked_at` (partial unique index keeps `credential_id`
 * reusable after revocation). `auth.webauthn_credentials` is FORCE RLS keyed on
 * `app.current_user_public_id`, so every method reads/writes via the request-scoped handle and callers
 * must run inside `withPrincipalDatabaseContext (user scope)` (the owning user public id is always known at the call
 * site — authenticated request or WebAuthn challenge).
 */
export class WebauthnCredentialRepository {
  async listActiveByUserId(userId: number): Promise<WebauthnCredentialRow[]> {
    // audit #36: bound this user-self-scoped read (limit+1 + capListWithWarning).
    const rows = await getRequestDatabase()
      .select()
      .from(webauthn_credentials)
      .where(and(eq(webauthn_credentials.user_id, userId), isNull(webauthn_credentials.revoked_at)))
      .limit(DEFAULT_REPOSITORY_LIST_LIMIT + 1);
    return capListWithWarning({
      rows,
      limit: DEFAULT_REPOSITORY_LIST_LIMIT,
      resource: 'auth.webauthn_credentials',
      context: { userId },
    });
  }

  async findActiveByCredentialId(credentialId: string): Promise<WebauthnCredentialRow | null> {
    const rows = await getRequestDatabase()
      .select()
      .from(webauthn_credentials)
      .where(
        and(
          eq(webauthn_credentials.credential_id, credentialId),
          isNull(webauthn_credentials.revoked_at),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async countActiveByUserId(userId: number): Promise<number> {
    const rows = await getRequestDatabase()
      .select({ value: sql<number>`count(*)::int` })
      .from(webauthn_credentials)
      .where(
        and(eq(webauthn_credentials.user_id, userId), isNull(webauthn_credentials.revoked_at)),
      );
    return rows[0]?.value ?? 0;
  }

  /**
   * Takes the per-user WebAuthn-credential creation-quota advisory lock (auto-releases at commit).
   *
   * @remarks
   * Must run inside the same transaction as the subsequent `countActiveByUserId` + `createCredential`
   * so concurrent registrations cannot both pass the cap check and overshoot the per-user passkey cap.
   */
  async acquireCreationQuotaLock(userId: number): Promise<void> {
    await acquireResourceQuotaLock(RESOURCE_QUOTA_LOCK_NAMESPACE.WEBAUTHN_CREDENTIAL, userId);
  }

  async createCredential(data: {
    user_id: number;
    credential_id: string;
    public_key: string;
    counter: number;
    device_type: string;
    backed_up: boolean;
    transports: string[];
  }): Promise<WebauthnCredentialRow> {
    const rows = await getRequestDatabase()
      .insert(webauthn_credentials)
      .values({
        public_id: generatePublicId('webauthnCredential'),
        user_id: data.user_id,
        credential_id: data.credential_id,
        public_key: data.public_key,
        counter: data.counter,
        device_type: data.device_type,
        backed_up: data.backed_up,
        transports: data.transports,
      })
      .returning();
    return rows[0]!;
  }

  async updateCounter(credentialId: string, counter: number): Promise<void> {
    /**
     * sec-D11: monotonicity guard for the WebAuthn signature counter (defense
     * in depth on top of the `@simplewebauthn/server` library verifier). The
     * spec marks a static or decreasing counter as the signal of a possibly-
     * cloned authenticator. The library enforces strict-increase at verify
     * time, but two concurrent verifies can both pass the in-memory check and
     * race the UPDATE — letting the second write roll the stored counter
     * backward. Pinning monotonicity into the SQL WHERE clause refuses any
     * regression at the storage layer regardless of caller ordering.
     *
     * Zero-counter authenticators (Apple Passkeys / Windows Hello) keep
     * `counter = 0` forever; `lt(counter, 0)` would always be false and lock
     * every subsequent login from those credentials. Branch on `counter === 0`
     * so the valid `0 → 0` no-op write is accepted via equality.
     */
    const monotonicityCondition =
      counter === 0
        ? eq(webauthn_credentials.counter, 0)
        : lt(webauthn_credentials.counter, counter);
    await getRequestDatabase()
      .update(webauthn_credentials)
      .set({
        counter,
        last_used_at: databaseNowTimestamp,
      })
      .where(
        and(
          eq(webauthn_credentials.credential_id, credentialId),
          isNull(webauthn_credentials.revoked_at),
          monotonicityCondition,
        ),
      );
  }

  async revokeByUserId(userId: number, credentialDatabaseId: number): Promise<void> {
    await getRequestDatabase()
      .update(webauthn_credentials)
      .set({ revoked_at: databaseNowTimestamp })
      .where(
        and(
          eq(webauthn_credentials.id, credentialDatabaseId),
          eq(webauthn_credentials.user_id, userId),
          isNull(webauthn_credentials.revoked_at),
        ),
      );
  }
}
