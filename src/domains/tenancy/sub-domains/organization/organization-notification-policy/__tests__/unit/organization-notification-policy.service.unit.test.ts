import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Blanket maintenance passthrough: services this suite touches (directly or via
    // cross-domain imports) may enter maintenance contexts (tombstoning, admin reads) —
    // the real wrapper opens a database.transaction() and CI's unit lane has no Postgres.
    withMaintenanceDatabaseContext: vi.fn(
      async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
    ),
    withPrincipalDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

import { NotFoundError } from '@/shared/errors/index.js';
import { OrganizationNotificationPolicyService } from '@/domains/tenancy/sub-domains/organization/organization-notification-policy/organization-notification-policy.service.js';
import type { OrganizationRepository } from '@/domains/tenancy/sub-domains/organization/organization.repository.js';
import type { OrganizationNotificationPolicyRepository } from '@/domains/tenancy/sub-domains/organization/organization-notification-policy/organization-notification-policy.repository.js';
import {
  createPrincipalDatabaseScope,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

const now = new Date('2026-01-01T00:00:00.000Z');
const organization = { id: 1, public_id: 'org_public_abc', name: 'Test Org' };
const policyRow = {
  id: 1,
  public_id: 'pol_public_1',
  organization_id: 1,
  notification_type: 'membership.invite_accepted',
  channel: 'EMAIL',
  default_enabled: true,
  is_mandatory: false,
  muted_until: null,
  created_at: now,
  updated_at: now,
};

const asScope = (organizationPublicId: string) =>
  createPrincipalDatabaseScope({
    organizationPublicId,
    source: 'token',
  }) as OrganizationPrincipalDatabaseScope;

describe('OrganizationNotificationPolicyService', () => {
  const organizationRepository = {
    findByPublicId: vi.fn().mockResolvedValue(organization),
    resolveUserIdByPublicId: vi.fn().mockResolvedValue(10),
  } as unknown as OrganizationRepository;

  const policyRepository = {
    findByOrganizationId: vi.fn().mockResolvedValue([policyRow]),
    findByPublicId: vi.fn().mockResolvedValue(policyRow),
    // sec-r5-followup-ratelimit-dos-3: create() now consults this guard
    // before insert. Default to 0 so existing tests still reach create;
    // the cap regression lives in `per-org-row-caps.unit.test.ts`.
    countActiveByOrganization: vi.fn().mockResolvedValue(0),
    // audit-#8: per-org creation quota advisory lock (no-op in unit tests).
    acquireCreationQuotaLock: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(policyRow),
    update: vi.fn().mockResolvedValue(policyRow),
    softDelete: vi.fn().mockResolvedValue(policyRow),
  } as unknown as OrganizationNotificationPolicyRepository;

  const service = new OrganizationNotificationPolicyService(
    organizationRepository,
    policyRepository,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(organizationRepository.findByPublicId).mockResolvedValue(organization as never);
    vi.mocked(policyRepository.findByOrganizationId).mockResolvedValue([policyRow] as never);
    vi.mocked(policyRepository.findByPublicId).mockResolvedValue(policyRow as never);
    vi.mocked(policyRepository.create).mockResolvedValue(policyRow as never);
    vi.mocked(policyRepository.update).mockResolvedValue(policyRow as never);
    vi.mocked(policyRepository.softDelete).mockResolvedValue(policyRow as never);
    vi.mocked(organizationRepository.resolveUserIdByPublicId).mockResolvedValue(10);
  });

  describe('list', () => {
    it('returns serialized policies for an organization', async () => {
      const result = await service.list(asScope('org_public_abc'));
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        organization_id: 'org_public_abc',
        notification_type: 'membership.invite_accepted',
        channel: 'EMAIL',
      });
    });

    it('throws NotFoundError when organization is missing', async () => {
      vi.mocked(organizationRepository.findByPublicId).mockResolvedValue(null);
      await expect(service.list(asScope('org_public_abc'))).rejects.toBeInstanceOf(NotFoundError);
    });

    it('returns empty array when no policies exist', async () => {
      vi.mocked(policyRepository.findByOrganizationId).mockResolvedValue([]);
      const result = await service.list(asScope('org_public_abc'));
      expect(result).toHaveLength(0);
    });
  });

  describe('getById', () => {
    it('returns serialized policy when found', async () => {
      const result = await service.getByPublicId(asScope('org_public_abc'), 'pol_public_1');
      expect(result).toMatchObject({ id: policyRow.public_id, organization_id: 'org_public_abc' });
    });

    it('throws NotFoundError when organization is missing', async () => {
      vi.mocked(organizationRepository.findByPublicId).mockResolvedValue(null);
      await expect(
        service.getByPublicId(asScope('org_public_abc'), 'pol_public_1'),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('throws NotFoundError when policy is missing', async () => {
      vi.mocked(policyRepository.findByPublicId).mockResolvedValue(null);
      await expect(
        service.getByPublicId(asScope('org_public_abc'), 'pol_public_1'),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('create', () => {
    const body = {
      notification_type: 'membership.invite_accepted',
      channel: 'EMAIL',
      default_enabled: true,
      is_mandatory: false,
    };

    it('creates and returns serialized policy', async () => {
      const result = await service.create(asScope('org_public_abc'), body, 'user_public');
      expect(policyRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: organization.id,
          notification_type: 'membership.invite_accepted',
          channel: 'EMAIL',
        }),
      );
      expect(result).toMatchObject({ organization_id: 'org_public_abc' });
    });

    it('throws NotFoundError when organization is missing', async () => {
      vi.mocked(organizationRepository.findByPublicId).mockResolvedValue(null);
      await expect(
        service.create(asScope('org_public_abc'), body, 'user_public'),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('propagates repository create errors', async () => {
      vi.mocked(policyRepository.create).mockRejectedValue(new Error('Unique constraint'));
      await expect(service.create(asScope('org_public_abc'), body, 'user_public')).rejects.toThrow(
        'Unique constraint',
      );
    });
  });

  describe('update', () => {
    it('updates and returns serialized policy', async () => {
      const result = await service.update(
        asScope('org_public_abc'),
        'pol_public_1',
        { default_enabled: false },
        'user_public',
      );
      expect(policyRepository.update).toHaveBeenCalled();
      expect(result).toMatchObject({ organization_id: 'org_public_abc' });
    });

    it('throws NotFoundError when organization is missing', async () => {
      vi.mocked(organizationRepository.findByPublicId).mockResolvedValue(null);
      await expect(
        service.update(
          asScope('org_public_abc'),
          'pol_public_1',
          { default_enabled: false },
          'user_public',
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('throws NotFoundError when policy update returns null', async () => {
      vi.mocked(policyRepository.update).mockResolvedValue(null);
      await expect(
        service.update(
          asScope('org_public_abc'),
          'pol_public_1',
          { default_enabled: false },
          'user_public',
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('delete', () => {
    it('soft-deletes the policy when found', async () => {
      await service.delete(asScope('org_public_abc'), 'pol_public_1');
      expect(policyRepository.softDelete).toHaveBeenCalledWith('pol_public_1', organization.id);
    });

    it('throws NotFoundError when organization is missing', async () => {
      vi.mocked(organizationRepository.findByPublicId).mockResolvedValue(null);
      await expect(
        service.delete(asScope('org_public_abc'), 'pol_public_1'),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('throws NotFoundError when policy is not found for deletion', async () => {
      vi.mocked(policyRepository.softDelete).mockResolvedValue(null);
      await expect(
        service.delete(asScope('org_public_abc'), 'pol_public_1'),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
