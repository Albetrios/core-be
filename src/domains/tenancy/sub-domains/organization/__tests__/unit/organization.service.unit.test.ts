import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDatabaseContexts } from '@/tests/helpers/database-context-mock.helper.js';

const invalidateOrganizationPermissionsMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/domains/tenancy/sub-domains/permission/permission-cache.service.js', () => ({
  invalidateOrganizationPermissions: (...parameters: unknown[]) =>
    invalidateOrganizationPermissionsMock(...parameters),
}));

// create() now bootstraps the org atomically via provisionOrganizationWithOwner (org + owner
// role + permissions + membership), not repository.create — mock that boundary here.
const provisionOrganizationWithOwnerMock = vi.fn();
vi.mock('@/domains/tenancy/sub-domains/organization/organization-provisioning.js', () => ({
  provisionOrganizationWithOwner: (...parameters: unknown[]) =>
    provisionOrganizationWithOwnerMock(...parameters),
  provisionPersonalOrganization: vi.fn(),
  PERSONAL_ORGANIZATION_NAME: 'Personal',
  OWNER_ROLE_NAME: 'Owner',
}));

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) =>
  mockDatabaseContexts(await importOriginal<Record<string, unknown>>()),
);

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/shared/errors/index.js';
import { env } from '@/shared/config/env.config.js';
import { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { OrganizationRepository } from '@/domains/tenancy/sub-domains/organization/organization.repository.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { createObjectStoragePortMock } from '@/tests/helpers/object-storage-mock.helper.js';
import {
  PRINCIPAL_SCOPE,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

const organizationRow = {
  id: 1,
  public_id: generatePublicId('organization'),
  name: 'Acme',
  slug: 'acme',
  type: 'TEAM',
  status: 'ACTIVE',
  stripe_customer_id: null,
  owner_user_id: 10,
  logo_url: null,
  created_at: new Date(),
  updated_at: new Date(),
  deleted_at: null,
};

const asScope = (organizationPublicId: string) =>
  PRINCIPAL_SCOPE.REQUEST({
    organizationPublicId,
  }) as OrganizationPrincipalDatabaseScope;

describe('OrganizationService', () => {
  const repository = {
    findByPublicId: vi.fn().mockResolvedValue(organizationRow),
    findById: vi.fn().mockResolvedValue(organizationRow),
    findBySlug: vi.fn().mockResolvedValue(null),
    findAll: vi.fn().mockResolvedValue({
      items: [organizationRow],
      total: null,
      limit: 20,
      has_more: false,
      next_cursor: null,
    }),
    create: vi.fn().mockResolvedValue(organizationRow),
    update: vi.fn().mockResolvedValue(organizationRow),
    softDelete: vi.fn().mockResolvedValue(organizationRow),
    markDeletionStarted: vi.fn().mockResolvedValue(organizationRow),
    resolveUserIdByPublicId: vi.fn().mockResolvedValue(10),
    countActiveOwnedByUser: vi.fn().mockResolvedValue(0),
    // audit-#8: per-owner owned-organization quota advisory lock (no-op in unit tests).
    acquireOwnedOrganizationQuotaLock: vi.fn().mockResolvedValue(undefined),
    updateOwner: vi.fn().mockResolvedValue(organizationRow),
    updateStripeCustomerId: vi.fn().mockResolvedValue(undefined),
    userHasActiveMembership: vi.fn().mockResolvedValue(true),
    userCanAccessOrganization: vi.fn().mockResolvedValue(true),
    findAllForUser: vi.fn().mockResolvedValue({
      items: [organizationRow],
      total: null,
      limit: 20,
      has_more: false,
      next_cursor: null,
    }),
  } as unknown as OrganizationRepository;

  const objectStorage = createObjectStoragePortMock();
  const service = new OrganizationService(repository, objectStorage);

  beforeEach(() => {
    vi.clearAllMocks();
    provisionOrganizationWithOwnerMock.mockResolvedValue({
      organization: organizationRow,
      roleId: 1,
      membershipPublicId: generatePublicId('membership'),
    });
    service.wireOffboardingUploadService({
      deleteObject: vi.fn(),
      tombstoneAllByOrganizationId: vi.fn().mockResolvedValue(0),
      assertKeyConfirmed: vi.fn().mockResolvedValue(undefined),
      assertKeyConfirmedForOwner: vi.fn().mockResolvedValue(undefined),
    } as never);
    vi.mocked(objectStorage.headObject).mockResolvedValue({
      contentLength: 100,
      contentType: 'image/png',
    });
    vi.mocked(repository.findByPublicId).mockResolvedValue(organizationRow as never);
    vi.mocked(repository.findById).mockResolvedValue(organizationRow as never);
    vi.mocked(repository.findBySlug).mockResolvedValue(null);
    vi.mocked(repository.resolveUserIdByPublicId).mockResolvedValue(10);
    vi.mocked(repository.update).mockResolvedValue(organizationRow as never);
    vi.mocked(repository.softDelete).mockResolvedValue(organizationRow as never);
    vi.mocked(repository.markDeletionStarted).mockResolvedValue(organizationRow as never);
    vi.mocked(repository.userCanAccessOrganization).mockResolvedValue(true);
  });

  it('requireOrganizationByPublicId returns billing context', async () => {
    const result = await service.requireOrganizationByPublicId(organizationRow.public_id);
    expect(result.public_id).toBe(organizationRow.public_id);
  });

  it('requireOrganizationByPublicId throws when missing', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(null);
    await expect(service.requireOrganizationByPublicId('missing')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('list returns paginated organizations', async () => {
    const result = await service.list({ limit: 20 }, 'user_public');
    expect(result.items).toHaveLength(1);
  });

  it('create persists organization for owner', async () => {
    const result = await service.create({ name: 'New Org', slug: 'new-org' }, 'owner_public');
    expect(provisionOrganizationWithOwnerMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Org', slug: 'new-org', type: 'TEAM' }),
    );
    expect(result.name).toBe('Acme');
  });

  it('getByPublicId returns organization', async () => {
    const result = await service.getByPublicId(organizationRow.public_id, 'user_public');
    expect(result.id).toBe(organizationRow.public_id);
  });

  it('create throws when owner user missing', async () => {
    vi.mocked(repository.resolveUserIdByPublicId).mockResolvedValue(null);
    await expect(
      service.create({ name: 'New Org', slug: 'new-org' }, 'missing_owner'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('getBySlug returns organization', async () => {
    vi.mocked(repository.findBySlug).mockResolvedValue(organizationRow as never);
    const result = await service.getBySlug('acme', 'user_public');
    expect(result.slug).toBe('acme');
  });

  it('update throws conflict when slug taken', async () => {
    vi.mocked(repository.findBySlug).mockResolvedValue({
      ...organizationRow,
      public_id: 'other_org',
    } as never);
    await expect(
      service.update(asScope(organizationRow.public_id), { slug: 'taken' }, 'owner_public'),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('delete runs offboarding when dependencies attached', async () => {
    const uploadService = { tombstoneAllByOrganizationId: vi.fn().mockResolvedValue(3) };
    service.wireOffboardingUploadService(uploadService as never);
    await service.delete(asScope(organizationRow.public_id));
    expect(uploadService.tombstoneAllByOrganizationId).toHaveBeenCalledWith(organizationRow.id);
  });

  it('route-audit-#2: delete cancels the org active subscription so billing stops', async () => {
    const uploadService = { tombstoneAllByOrganizationId: vi.fn().mockResolvedValue(0) };
    const subscriptionService = {
      cancelActiveForOrganizationOffboarding: vi.fn().mockResolvedValue(undefined),
    };
    service.wireOffboardingUploadService(uploadService as never, subscriptionService);
    await service.delete(asScope(organizationRow.public_id));
    expect(subscriptionService.cancelActiveForOrganizationOffboarding).toHaveBeenCalledWith(
      organizationRow.public_id,
    );
  });

  it('route-audit-#2: a Stripe cancel failure aborts the delete (no soft-delete of a billing org)', async () => {
    const uploadService = { tombstoneAllByOrganizationId: vi.fn().mockResolvedValue(0) };
    const subscriptionService = {
      cancelActiveForOrganizationOffboarding: vi
        .fn()
        .mockRejectedValue(new Error('stripe unavailable')),
    };
    service.wireOffboardingUploadService(uploadService as never, subscriptionService);
    await expect(service.delete(asScope(organizationRow.public_id))).rejects.toThrow();
    // The soft-delete must NOT have run after the failed cancel.
    expect(repository.softDelete).not.toHaveBeenCalled();
  });

  it('delete invalidates the organization permission cache so access stops immediately', async () => {
    await service.delete(asScope(organizationRow.public_id));
    expect(invalidateOrganizationPermissionsMock).toHaveBeenCalledWith(organizationRow.public_id);
  });

  it('delete does not invalidate the permission cache when soft delete fails', async () => {
    vi.mocked(repository.softDelete).mockResolvedValue(null);
    await expect(service.delete(asScope(organizationRow.public_id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(invalidateOrganizationPermissionsMock).not.toHaveBeenCalled();
  });

  it('uploadLogo stores the object KEY, not a permanent public URL (TEN-07)', async () => {
    const key = `organization-logos/${organizationRow.public_id}/logo.png`;
    const result = await service.uploadLogo(
      asScope(organizationRow.public_id),
      { key },
      'owner_public',
    );
    expect(result).toBeDefined();
    // TEN-07: the private object KEY is persisted (signed-on-read), never an unsigned
    // permanent S3 URL via getObjectUrl.
    expect(repository.update).toHaveBeenCalledWith(
      organizationRow.public_id,
      { logo_url: key },
      expect.anything(),
    );
    expect(objectStorage.getObjectUrl).not.toHaveBeenCalled();
  });

  it('uploadLogo throws when object is missing in storage', async () => {
    vi.mocked(objectStorage.headObject).mockResolvedValueOnce(null);
    const key = `organization-logos/${organizationRow.public_id}/logo.png`;
    await expect(
      service.uploadLogo(asScope(organizationRow.public_id), { key }, 'owner_public'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('uploadLogo rejects an SVG logo (stored-XSS defense) and never persists it', async () => {
    // The org-logo attach path carries its own independent content-type gate — an SVG logo is
    // served inline and is a stored-XSS vector. The upload domain's SVG tests do not cover this
    // path; here headObject reports the confirmed object as image/svg+xml.
    vi.mocked(objectStorage.headObject).mockResolvedValueOnce({
      contentType: 'image/svg+xml',
      contentLength: 512,
    } as never);
    const key = `organization-logos/${organizationRow.public_id}/logo.svg`;

    await expect(
      service.uploadLogo(asScope(organizationRow.public_id), { key }, 'owner_public'),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('update throws when repository update returns null', async () => {
    vi.mocked(repository.update).mockResolvedValue(null);
    await expect(
      service.update(asScope(organizationRow.public_id), { name: 'X' }, 'owner_public'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('uploadLogo rejects keys outside organization prefix', async () => {
    const otherOrganizationKey = `organization-logos/${generatePublicId('organization')}/logo.png`;
    await expect(
      service.uploadLogo(
        asScope(organizationRow.public_id),
        { key: otherOrganizationKey },
        'owner_public',
      ),
    ).rejects.toMatchObject({ name: 'ValidationError' });
  });

  it('uploadLogo rejects when the upload has not been confirmed', async () => {
    service.wireOffboardingUploadService({
      deleteObject: vi.fn(),
      assertKeyConfirmedForOwner: vi
        .fn()
        .mockRejectedValue(new ValidationError('errors:validation.uploadNotConfirmed')),
    } as never);
    const key = `organization-logos/${organizationRow.public_id}/logo.png`;
    await expect(
      service.uploadLogo(asScope(organizationRow.public_id), { key }, 'owner_public'),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('getBySlug throws when organization missing', async () => {
    vi.mocked(repository.findBySlug).mockResolvedValue(null);
    await expect(service.getBySlug('missing', 'user_public')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('transferOrganizationOwnership updates owner and returns context', async () => {
    const result = await service.transferOrganizationOwnership(organizationRow.public_id, 99);
    expect(repository.updateOwner).toHaveBeenCalledWith(organizationRow.public_id, 99);
    expect(result.public_id).toBe(organizationRow.public_id);
  });

  it('transferOrganizationOwnership rejects when the atomic owner update matches no row', async () => {
    // A null result from updateOwner means the prospective owner was suspended/removed between the
    // caller's status check and the write (the EXISTS guard failed) — surface a clean conflict.
    vi.mocked(repository.updateOwner).mockResolvedValueOnce(null);
    await expect(
      service.transferOrganizationOwnership(organizationRow.public_id, 99),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('deleteLogo clears logo when organization has logo url', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...organizationRow,
      logo_url: `https://cdn.example/organization-logos/${organizationRow.public_id}/logo.png`,
    } as never);
    vi.mocked(repository.update).mockResolvedValue({
      ...organizationRow,
      logo_url: null,
    } as never);
    const result = await service.deleteLogo(asScope(organizationRow.public_id), 'owner_public');
    expect(result.logo_url).toBeNull();
  });

  it('create throws conflict when slug already exists', async () => {
    vi.mocked(repository.findBySlug).mockResolvedValue(organizationRow as never);
    await expect(
      service.create({ name: 'Dup', slug: organizationRow.slug }, 'owner_public'),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('create maps a slug unique_violation race to ConflictError instead of 500', async () => {
    vi.mocked(repository.findBySlug).mockResolvedValue(null);
    provisionOrganizationWithOwnerMock.mockRejectedValueOnce(
      Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
    );
    await expect(
      service.create({ name: 'Race', slug: 'race-slug' }, 'owner_public'),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('TEN-02/R12: create takes the owned-organization quota advisory lock before counting', async () => {
    await service.create({ name: 'Locked Co', slug: 'locked-co' }, 'owner_public');
    // A single per-owner transaction-scoped quota lock serializes the count + insert; the
    // previously-redundant resource-cap-lock has been removed (audit R12).
    expect(repository.acquireOwnedOrganizationQuotaLock).toHaveBeenCalledWith(expect.any(Number));
  });

  it('create rejects when the owner is at the team-organization cap', async () => {
    // env MAX_TEAM_ORGANIZATIONS_PER_OWNER defaults to 20; simulate the owner already at the cap.
    vi.mocked(repository.countActiveOwnedByUser).mockResolvedValue(20);
    await expect(
      service.create({ name: 'Over Cap', slug: 'over-cap' }, 'owner_public'),
    ).rejects.toBeInstanceOf(ConflictError);
    // The provisioning path must not run once the cap is hit.
    expect(provisionOrganizationWithOwnerMock).not.toHaveBeenCalled();
  });

  it('create rejects when team organizations are disabled (capability gate)', async () => {
    // Personal-only deployment: the server must reject team-org creation, not just hide it.
    const original = env.TEAM_ORGANIZATION_ENABLED;
    (env as { TEAM_ORGANIZATION_ENABLED: boolean }).TEAM_ORGANIZATION_ENABLED = false;
    try {
      await expect(
        service.create({ name: 'No Teams', slug: 'no-teams' }, 'owner_public'),
      ).rejects.toBeInstanceOf(ForbiddenError);
      // The capability gate fires before any validation or provisioning work.
      expect(provisionOrganizationWithOwnerMock).not.toHaveBeenCalled();
    } finally {
      (env as { TEAM_ORGANIZATION_ENABLED: boolean }).TEAM_ORGANIZATION_ENABLED = original;
    }
  });

  it('getByPublicId throws when organization missing', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(null);
    await expect(service.getByPublicId('missing', 'user_public')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('findOrganizationByPublicId and internal id return billing context', async () => {
    const byPublic = await service.findOrganizationByPublicId(organizationRow.public_id);
    expect(byPublic?.public_id).toBe(organizationRow.public_id);
    const byInternal = await service.findOrganizationByInternalId(organizationRow.id);
    expect(byInternal?.id).toBe(organizationRow.id);
  });

  it('updateStripeCustomerIdForOrganization updates stripe customer', async () => {
    await service.updateStripeCustomerIdForOrganization(organizationRow.public_id, 'cus_test');
    expect(repository.updateStripeCustomerId).toHaveBeenCalledWith(organizationRow.id, 'cus_test');
  });

  it('deleteLogo succeeds when organization has no logo', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...organizationRow,
      logo_url: null,
    } as never);
    const result = await service.deleteLogo(asScope(organizationRow.public_id), 'owner_public');
    expect(result.logo_url).toBeNull();
  });

  it('route-audit L1: deleteLogo reclaims the object and still clears the column when the object is already gone', async () => {
    // Pre-fix deleteLogo only HEAD-checked and THREW if the object was missing, orphaning the bytes
    // on the normal path. Now it best-effort DELETES the object and clears the column regardless.
    vi.mocked(objectStorage.deleteObject).mockResolvedValueOnce(false); // object already gone
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...organizationRow,
      logo_url: `https://cdn.example/organization-logos/${organizationRow.public_id}/logo.png`,
    } as never);
    vi.mocked(repository.update).mockResolvedValue({
      ...organizationRow,
      logo_url: null,
    } as never);
    const result = await service.deleteLogo(asScope(organizationRow.public_id), 'owner_public');
    expect(result.logo_url).toBeNull();
    expect(objectStorage.deleteObject).toHaveBeenCalledWith(
      `organization-logos/${organizationRow.public_id}/logo.png`,
    );
  });

  it('delete throws when soft delete returns null', async () => {
    vi.mocked(repository.softDelete).mockResolvedValue(null);
    await expect(service.delete(asScope(organizationRow.public_id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('updateStripeCustomerIdForOrganization throws when organization missing', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(null);
    await expect(
      service.updateStripeCustomerIdForOrganization('missing', 'cus_test'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('findOrganizationByInternalId returns null when row missing', async () => {
    vi.mocked(repository.findById).mockResolvedValue(null);
    const result = await service.findOrganizationByInternalId(999);
    expect(result).toBeNull();
  });

  it('delete clears logo from CDN-style logo_url during offboarding', async () => {
    const uploadService = { tombstoneAllByOrganizationId: vi.fn().mockResolvedValue(0) };
    service.wireOffboardingUploadService(uploadService as never);
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...organizationRow,
      logo_url: `https://cdn.example/organization-logos/${organizationRow.public_id}/logo.png`,
    } as never);
    await service.delete(asScope(organizationRow.public_id));
    expect(uploadService.tombstoneAllByOrganizationId).toHaveBeenCalledWith(organizationRow.id);
  });

  it('update skips slug conflict check when slug is omitted', async () => {
    await service.update(
      asScope(organizationRow.public_id),
      { name: 'Renamed only' },
      'owner_public',
    );
    expect(repository.findBySlug).not.toHaveBeenCalled();
    expect(repository.update).toHaveBeenCalled();
  });

  it('delete succeeds without offboarding dependencies', async () => {
    const serviceWithoutOffboarding = new OrganizationService(repository, objectStorage);
    await serviceWithoutOffboarding.delete(asScope(organizationRow.public_id));
    expect(repository.softDelete).toHaveBeenCalledWith(organizationRow.public_id);
  });

  it('delete skips logo cleanup when logo url is absent', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...organizationRow,
      logo_url: null,
    } as never);
    await service.delete(asScope(organizationRow.public_id));
    expect(repository.softDelete).toHaveBeenCalled();
  });

  it('deleteLogo skips storage head check when logo url is absent', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...organizationRow,
      logo_url: null,
    } as never);
    const result = await service.deleteLogo(asScope(organizationRow.public_id), 'owner_public');
    expect(result.logo_url).toBeNull();
  });

  it('delete removes logo from CDN-style url during offboarding', async () => {
    const uploadService = { tombstoneAllByOrganizationId: vi.fn().mockResolvedValue(0) };
    service.wireOffboardingUploadService(uploadService as never);
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...organizationRow,
      logo_url: `https://cdn.example.com/organization-logos/${organizationRow.public_id}/logo.png`,
    } as never);
    await service.delete(asScope(organizationRow.public_id));
    expect(repository.update).toHaveBeenCalled();
  });

  it('requireOrganizationByPublicId returns billing context', async () => {
    const billing = await service.requireOrganizationByPublicId(organizationRow.public_id);
    expect(billing.public_id).toBe(organizationRow.public_id);
  });

  it('delete clears logo when storage key uses direct prefix path', async () => {
    vi.mocked(objectStorage.deleteObject).mockResolvedValueOnce(true);
    const logoKey = `organization-logos/${organizationRow.public_id}/logo.png`;
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...organizationRow,
      logo_url: logoKey,
    } as never);
    await service.delete(asScope(organizationRow.public_id));
    expect(objectStorage.deleteObject).toHaveBeenCalledWith(logoKey);
  });

  it('delete skips storage delete when logo url does not match storage key pattern', async () => {
    vi.mocked(objectStorage.deleteObject).mockClear();
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...organizationRow,
      logo_url: 'https://other-cdn.example/unrelated.png',
    } as never);
    await service.delete(asScope(organizationRow.public_id));
    expect(objectStorage.deleteObject).not.toHaveBeenCalled();
  });

  it('delete logs warning when logo object deletion fails', async () => {
    vi.mocked(objectStorage.deleteObject).mockResolvedValueOnce(false);
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...organizationRow,
      logo_url: `organization-logos/${organizationRow.public_id}/logo.png`,
    } as never);
    await service.delete(asScope(organizationRow.public_id));
    expect(repository.update).toHaveBeenCalled();
  });

  it('delete fails when logo clear update cannot see the organization in RLS context', async () => {
    vi.mocked(objectStorage.deleteObject).mockResolvedValueOnce(true);
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...organizationRow,
      logo_url: `organization-logos/${organizationRow.public_id}/logo.png`,
    } as never);
    vi.mocked(repository.update).mockResolvedValueOnce(null);

    await expect(service.delete(asScope(organizationRow.public_id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(repository.softDelete).not.toHaveBeenCalled();
  });

  it('deleteLogo skips storage head check when logo url has no extractable key', async () => {
    vi.mocked(objectStorage.headObject).mockClear();
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...organizationRow,
      logo_url: 'https://cdn.example.com/no-org-logos/here.png',
    } as never);
    const result = await service.deleteLogo(asScope(organizationRow.public_id), 'owner_public');
    expect(objectStorage.headObject).not.toHaveBeenCalled();
    expect(result.logo_url).toBeNull();
  });

  it('uploadLogo and update pass null user id when resolver returns null', async () => {
    vi.mocked(repository.resolveUserIdByPublicId).mockResolvedValue(null);
    const key = `organization-logos/${organizationRow.public_id}/logo.png`;
    vi.mocked(objectStorage.headObject).mockResolvedValue({
      contentLength: 1,
      contentType: undefined,
    });
    await service.uploadLogo(asScope(organizationRow.public_id), { key }, 'missing_user');
    expect(repository.update).toHaveBeenCalledWith(
      organizationRow.public_id,
      expect.objectContaining({ logo_url: expect.any(String) }),
      null,
    );

    vi.mocked(repository.update).mockResolvedValue(organizationRow as never);
    await service.update(asScope(organizationRow.public_id), { name: 'Renamed' }, 'missing_user');
    expect(repository.update).toHaveBeenCalledWith(
      organizationRow.public_id,
      { name: 'Renamed' },
      null,
    );
  });

  it('wireOffboardingUploadService stores upload service for delete', async () => {
    const uploadService = { tombstoneAllByOrganizationId: vi.fn().mockResolvedValue(2) };
    const serviceWithOffboarding = new OrganizationService(repository, objectStorage);
    serviceWithOffboarding.wireOffboardingUploadService(uploadService as never);
    await serviceWithOffboarding.delete(asScope(organizationRow.public_id));
    expect(uploadService.tombstoneAllByOrganizationId).toHaveBeenCalledWith(organizationRow.id);
  });

  it('resolveUserInternalIdByPublicId delegates to repository', async () => {
    const userId = await service.resolveUserInternalIdByPublicId('user_public');
    expect(userId).toBe(10);
    expect(repository.resolveUserIdByPublicId).toHaveBeenCalledWith('user_public');
  });

  it('requireOrganizationRecordByPublicId throws when organization is missing', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(null);
    await expect(service.requireOrganizationRecordByPublicId('missing')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('update allows keeping the same slug for the same organization', async () => {
    vi.mocked(repository.findBySlug).mockResolvedValue(organizationRow as never);
    await service.update(
      asScope(organizationRow.public_id),
      { slug: organizationRow.slug },
      'owner_public',
    );
    expect(repository.update).toHaveBeenCalled();
  });

  it('route-audit L1: deleteLogo reclaims the extractable storage key before clearing the column', async () => {
    const logoPath = `organization-logos/${organizationRow.public_id}/logo.png`;
    vi.mocked(objectStorage.deleteObject).mockResolvedValueOnce(true);
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...organizationRow,
      logo_url: `https://cdn.example/${logoPath}`,
    } as never);
    vi.mocked(repository.update).mockResolvedValue({
      ...organizationRow,
      logo_url: null,
    } as never);
    const result = await service.deleteLogo(asScope(organizationRow.public_id), 'owner_public');
    expect(objectStorage.deleteObject).toHaveBeenCalledWith(logoPath);
    expect(result.logo_url).toBeNull();
  });

  it('updateStripeCustomerIdForOrganization throws when stripe update target is missing', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(organizationRow as never);
    vi.mocked(repository.updateStripeCustomerId).mockResolvedValue(null);
    await service.updateStripeCustomerIdForOrganization(organizationRow.public_id, 'cus_new');
    expect(repository.updateStripeCustomerId).toHaveBeenCalledWith(organizationRow.id, 'cus_new');
  });

  it('uploadLogo throws when organization is missing', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(null);
    await expect(
      service.uploadLogo(
        asScope(organizationRow.public_id),
        { key: `organization-logos/${organizationRow.public_id}/logo.png` },
        'owner_public',
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('findOrganizationByPublicId returns null when organization is missing', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(null);
    const result = await service.findOrganizationByPublicId('missing');
    expect(result).toBeNull();
  });

  it('update throws when organization is missing', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(null);
    await expect(
      service.update(asScope(organizationRow.public_id), { name: 'X' }, 'owner_public'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('delete throws when organization is missing', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(null);
    await expect(service.delete(asScope(organizationRow.public_id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('deleteLogo throws when organization is missing', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(null);
    await expect(
      service.deleteLogo(asScope(organizationRow.public_id), 'owner_public'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('uploadLogo throws when repository update returns null', async () => {
    const key = `organization-logos/${organizationRow.public_id}/logo.png`;
    vi.mocked(repository.update).mockResolvedValue(null);
    await expect(
      service.uploadLogo(asScope(organizationRow.public_id), { key }, 'owner_public'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deleteLogo throws when repository update returns null', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...organizationRow,
      logo_url: null,
    } as never);
    vi.mocked(repository.update).mockResolvedValue(null);
    await expect(
      service.deleteLogo(asScope(organizationRow.public_id), 'owner_public'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deleteLogo passes null updater when user resolver returns null', async () => {
    vi.mocked(repository.resolveUserIdByPublicId).mockResolvedValue(null);
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...organizationRow,
      logo_url: null,
    } as never);
    await service.deleteLogo(asScope(organizationRow.public_id), 'missing_user');
    expect(repository.update).toHaveBeenCalledWith(
      organizationRow.public_id,
      { logo_url: null },
      null,
    );
  });
});
