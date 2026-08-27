import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { env } from '@/shared/config/env.config.js';
import { databaseNowTimestamp } from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { organization_notification_policies } from '@/domains/tenancy/sub-domains/organization/organization-notification-policy/organization-notification-policy.schema.js';
import {
  RESOURCE_QUOTA_LOCK_NAMESPACE,
  acquireResourceQuotaLock,
} from '@/infrastructure/database/resource-quota-lock.util.js';
import type { OrganizationNotificationPolicyRow } from './organization-notification-policy.types.js';

/**
 * sec-D1: a `muted_until` slipped into the past must be persisted as NULL.
 * Mute expiry is a read-side concern (selects filter `muted_until > now()`);
 * persisting a stale value created a footgun where the old volatile CHECK
 * would wedge the row on subsequent updates. Even with the CHECK dropped,
 * keeping the column clean simplifies dashboards and reasoning.
 */
function normalizeMuteForPersistence(mutedUntil: Date | null | undefined): Date | null | undefined {
  if (mutedUntil === undefined) return undefined;
  if (mutedUntil === null) return null;
  return mutedUntil.getTime() > Date.now() ? mutedUntil : null;
}

/**
 * Drizzle data-access for `tenancy.organization_notification_policies`.
 * Supports per-org list (ordered by `notification_type` then `channel`),
 * primary-key lookup scoped to the organization, soft-delete-aware upsert
 * keyed on `(organization_id, notification_type, channel)`, partial update,
 * and soft-delete.
 */
export class OrganizationNotificationPolicyRepository {
  /**
   * Counts the active (not soft-deleted) notification policies for the given
   * organization.
   *
   * @remarks
   * sec-r5-followup-ratelimit-dos-3: used by `OrganizationNotificationPolicyService.create`
   * to enforce `ORGANIZATION_NOTIFICATION_POLICY_MAX_PER_ORG`. Same shape as
   * `webhook.repository.countActiveByOrganization`.
   */
  async countActiveByOrganization(organization_id: number): Promise<number> {
    const rows = await getRequestDatabase()
      .select({ value: sql<number>`count(*)::int` })
      .from(organization_notification_policies)
      .where(
        and(
          eq(organization_notification_policies.organization_id, organization_id),
          isNull(organization_notification_policies.deleted_at),
        ),
      );
    return rows[0]?.value ?? 0;
  }

  /**
   * audit-#8: transaction-scoped advisory lock serializing the per-org notification-policy
   * creation quota check + insert so concurrent creates cannot both pass the count and overshoot
   * `ORGANIZATION_NOTIFICATION_POLICY_MAX_PER_ORG`. Call inside the create transaction before
   * {@link countActiveByOrganization}.
   */
  async acquireCreationQuotaLock(organization_id: number): Promise<void> {
    await acquireResourceQuotaLock(
      RESOURCE_QUOTA_LOCK_NAMESPACE.ORGANIZATION_NOTIFICATION_POLICY,
      organization_id,
    );
  }

  async findByOrganizationId(organization_id: number) {
    const rows = await getRequestDatabase()
      .select()
      .from(organization_notification_policies)
      .where(
        and(
          eq(organization_notification_policies.organization_id, organization_id),
          isNull(organization_notification_policies.deleted_at),
        ),
      )
      .orderBy(
        asc(organization_notification_policies.notification_type),
        asc(organization_notification_policies.channel),
      )
      // sec-r5-followup-ratelimit-dos-3: defense-in-depth cap matching the
      // create-time MAX_PER_ORG constant so a corrupted table cannot page
      // unbounded rows into the API process on the per-org list endpoint.
      .limit(env.ORGANIZATION_NOTIFICATION_POLICY_MAX_PER_ORG);
    return rows as OrganizationNotificationPolicyRow[];
  }

  async findByPublicId(
    public_id: string,
    organization_id: number,
  ): Promise<OrganizationNotificationPolicyRow | null> {
    const rows = await getRequestDatabase()
      .select()
      .from(organization_notification_policies)
      .where(
        and(
          eq(organization_notification_policies.public_id, public_id),
          eq(organization_notification_policies.organization_id, organization_id),
          isNull(organization_notification_policies.deleted_at),
        ),
      )
      .limit(1);
    return (rows[0] ?? null) as OrganizationNotificationPolicyRow | null;
  }

  async create(data: {
    organization_id: number;
    notification_type: string;
    channel: string;
    default_enabled?: boolean;
    is_mandatory?: boolean;
    muted_until?: Date | null;
    created_by_user_id?: number | null;
  }) {
    const mutableCreatedBy = data.created_by_user_id ?? undefined;
    // sec-D1: stale mute (date in past) is read-side semantically equivalent
    // to NULL. Normalize on write so a future-introduced CHECK / trigger
    // never wedges the row on a subsequent UPDATE.
    const normalizedMutedUntil = normalizeMuteForPersistence(data.muted_until);
    const rows = await getRequestDatabase()
      .insert(organization_notification_policies)
      .values({
        public_id: generatePublicId('organizationNotificationPolicy'),
        organization_id: data.organization_id,
        notification_type: data.notification_type,
        channel: data.channel,
        default_enabled: data.default_enabled ?? true,
        is_mandatory: data.is_mandatory ?? false,
        muted_until: normalizedMutedUntil ?? undefined,
        ...(mutableCreatedBy !== undefined && {
          created_by_user_id: mutableCreatedBy,
          updated_by_user_id: mutableCreatedBy,
        }),
      })
      .onConflictDoUpdate({
        target: [
          organization_notification_policies.organization_id,
          organization_notification_policies.notification_type,
          organization_notification_policies.channel,
        ],
        set: {
          deleted_at: null,
          default_enabled: data.default_enabled ?? true,
          is_mandatory: data.is_mandatory ?? false,
          muted_until: normalizedMutedUntil ?? undefined,
          updated_at: databaseNowTimestamp,
          updated_by_user_id: mutableCreatedBy,
        },
      })
      .returning();
    return rows[0]! as OrganizationNotificationPolicyRow;
  }

  async update(
    public_id: string,
    organization_id: number,
    data: {
      default_enabled?: boolean;
      is_mandatory?: boolean;
      muted_until?: Date | null;
    },
    updated_by_user_id: number | null,
  ): Promise<OrganizationNotificationPolicyRow | null> {
    // sec-D1: same normalization on update — never persist a stale mute.
    const normalizedData =
      data.muted_until === undefined
        ? data
        : { ...data, muted_until: normalizeMuteForPersistence(data.muted_until) };
    const rows = await getRequestDatabase()
      .update(organization_notification_policies)
      .set({
        ...normalizedData,
        updated_at: databaseNowTimestamp,
        updated_by_user_id: updated_by_user_id ?? undefined,
      })
      .where(
        and(
          eq(organization_notification_policies.public_id, public_id),
          eq(organization_notification_policies.organization_id, organization_id),
          isNull(organization_notification_policies.deleted_at),
        ),
      )
      .returning();
    return (rows[0] ?? null) as OrganizationNotificationPolicyRow | null;
  }

  async softDelete(
    public_id: string,
    organization_id: number,
  ): Promise<OrganizationNotificationPolicyRow | null> {
    const rows = await getRequestDatabase()
      .update(organization_notification_policies)
      .set({ deleted_at: databaseNowTimestamp, updated_at: databaseNowTimestamp })
      .where(
        and(
          eq(organization_notification_policies.public_id, public_id),
          eq(organization_notification_policies.organization_id, organization_id),
          isNull(organization_notification_policies.deleted_at),
        ),
      )
      .returning();
    return (rows[0] ?? null) as OrganizationNotificationPolicyRow | null;
  }
}
