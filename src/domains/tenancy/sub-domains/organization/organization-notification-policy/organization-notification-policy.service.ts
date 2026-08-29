import { env } from '@/shared/config/env.config.js';
import { ConflictError, NotFoundError } from '@/shared/errors/index.js';
import {
  withAppDatabaseContext,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationRepository } from '@/domains/tenancy/sub-domains/organization/organization.repository.js';
import type { OrganizationNotificationPolicyRepository } from './organization-notification-policy.repository.js';
import type { OrganizationNotificationPolicyOutput } from './organization-notification-policy.types.js';
import {
  validateCreateOrganizationNotificationPolicy,
  validateUpdateOrganizationNotificationPolicy,
} from './organization-notification-policy.validator.js';
import { serializeOrganizationNotificationPolicy } from './organization-notification-policy.serializer.js';

/**
 * Tenancy service for organization-scoped notification-delivery policies
 * (CRUD over `(notification_type, channel)` pairs).
 *
 * @remarks
 * - **Algorithm:** every operation is wrapped in
 *   `withAppDatabaseContext` so RLS (`app.current_organization_public_id`)
 *   matches the resource. Create defers to the repository's upsert which
 *   resurrects soft-deleted rows on `(organization_id, notification_type,
 *   channel)` conflicts. Update copies only defined fields and converts
 *   `muted_until` ISO strings to `Date`.
 * - **Failure modes:** `NotFoundError('Organization')` when the parent
 *   tenant is missing or invisible under RLS;
 *   `NotFoundError('Organization notification policy')` for unknown ids;
 *   `ValidationError` from the DTO validators.
 * - **Side effects:** persistent writes to
 *   `tenancy.organization_notification_policies`; no event emission and no
 *   external I/O.
 * - **Notes:** soft-delete only — tombstone hard-delete is performed by the
 *   organization-notification-policy retention worker.
 */
export class OrganizationNotificationPolicyService {
  constructor(
    private readonly organizationRepository: OrganizationRepository,
    private readonly policyRepository: OrganizationNotificationPolicyRepository,
  ) {}

  async list(
    scope: OrganizationPrincipalDatabaseScope,
  ): Promise<OrganizationNotificationPolicyOutput[]> {
    const organization_public_id = scope.organizationPublicId;
    return withAppDatabaseContext(scope, async () => {
      const organization = await this.organizationRepository.findByPublicId(organization_public_id);
      if (!organization) throw new NotFoundError('Organization');
      const rows = await this.policyRepository.findByOrganizationId(organization.id);
      return rows.map((row) =>
        serializeOrganizationNotificationPolicy(row, organization_public_id),
      );
    });
  }

  async getByPublicId(
    scope: OrganizationPrincipalDatabaseScope,
    policy_public_id: string,
  ): Promise<OrganizationNotificationPolicyOutput> {
    const organization_public_id = scope.organizationPublicId;
    return withAppDatabaseContext(scope, async () => {
      const organization = await this.organizationRepository.findByPublicId(organization_public_id);
      if (!organization) throw new NotFoundError('Organization');
      const row = await this.policyRepository.findByPublicId(policy_public_id, organization.id);
      if (!row) throw new NotFoundError('Organization notification policy');
      return serializeOrganizationNotificationPolicy(row, organization_public_id);
    });
  }

  async create(
    scope: OrganizationPrincipalDatabaseScope,
    body: unknown,
    created_by_user_public_id: string | undefined,
  ): Promise<OrganizationNotificationPolicyOutput> {
    const organization_public_id = scope.organizationPublicId;
    const parsed = validateCreateOrganizationNotificationPolicy(body);
    return withAppDatabaseContext(scope, async () => {
      const organization = await this.organizationRepository.findByPublicId(organization_public_id);
      if (!organization) throw new NotFoundError('Organization');
      // sec-r5-followup-ratelimit-dos-3 + audit-#8: serialize the per-organization count + insert with a
      // transaction-scoped advisory lock so concurrent creates cannot both pass the same count
      // and overshoot ORGANIZATION_NOTIFICATION_POLICY_MAX_PER_ORG. The lock auto-releases at commit.
      await this.policyRepository.acquireCreationQuotaLock(organization.id);
      const activeCount = await this.policyRepository.countActiveByOrganization(organization.id);
      if (activeCount >= env.ORGANIZATION_NOTIFICATION_POLICY_MAX_PER_ORG) {
        throw new ConflictError('errors:organizationNotificationPolicyMaxReached', {
          max: env.ORGANIZATION_NOTIFICATION_POLICY_MAX_PER_ORG,
        });
      }
      const userId =
        await this.organizationRepository.resolveUserIdByPublicId(created_by_user_public_id);
      const mutedUntil = parsed.muted_until ? new Date(parsed.muted_until) : null;
      const row = await this.policyRepository.create({
        organization_id: organization.id,
        notification_type: parsed.notification_type,
        channel: parsed.channel,
        default_enabled: parsed.default_enabled,
        is_mandatory: parsed.is_mandatory,
        muted_until: mutedUntil,
        created_by_user_id: userId,
      });
      return serializeOrganizationNotificationPolicy(row, organization_public_id);
    });
  }

  async update(
    scope: OrganizationPrincipalDatabaseScope,
    policy_public_id: string,
    body: unknown,
    updated_by_user_public_id: string | undefined,
  ): Promise<OrganizationNotificationPolicyOutput> {
    const organization_public_id = scope.organizationPublicId;
    const parsed = validateUpdateOrganizationNotificationPolicy(body);
    return withAppDatabaseContext(scope, async () => {
      const organization = await this.organizationRepository.findByPublicId(organization_public_id);
      if (!organization) throw new NotFoundError('Organization');
      const userId =
        await this.organizationRepository.resolveUserIdByPublicId(updated_by_user_public_id);
      const data: {
        default_enabled?: boolean;
        is_mandatory?: boolean;
        muted_until?: Date | null;
      } = {};
      if (parsed.default_enabled !== undefined) data.default_enabled = parsed.default_enabled;
      if (parsed.is_mandatory !== undefined) data.is_mandatory = parsed.is_mandatory;
      if (parsed.muted_until !== undefined) {
        data.muted_until = parsed.muted_until ? new Date(parsed.muted_until) : null;
      }
      const row = await this.policyRepository.update(
        policy_public_id,
        organization.id,
        data,
        userId ?? null,
      );
      if (!row) throw new NotFoundError('Organization notification policy');
      return serializeOrganizationNotificationPolicy(row, organization_public_id);
    });
  }

  async delete(scope: OrganizationPrincipalDatabaseScope, policy_public_id: string): Promise<void> {
    const organization_public_id = scope.organizationPublicId;
    return withAppDatabaseContext(scope, async () => {
      const organization = await this.organizationRepository.findByPublicId(organization_public_id);
      if (!organization) throw new NotFoundError('Organization');
      const deleted = await this.policyRepository.softDelete(policy_public_id, organization.id);
      if (!deleted) throw new NotFoundError('Organization notification policy');
    });
  }
}
