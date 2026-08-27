import { describe, it, expect, beforeEach } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  createMembership,
  createRoleWithPermissions,
  seedPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { createObjectStoragePortMock } from '@/tests/helpers/object-storage-mock.helper.js';
import { NotFoundError } from '@/shared/errors/index.js';
import { NotificationRepository } from '@/domains/notify/sub-domains/notification/notification.repository.js';
import { AuditRepository } from '@/domains/audit/audit.repository.js';
import { database } from '@/infrastructure/database/connection.js';
import { sessions } from '@/domains/auth/sub-domains/auth-session/auth-session.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { createDomainContainers } from '@/worker-containers.js';
import { withPrincipalDatabaseContext } from '@/infrastructure/database/contexts/principal-database.context.js';
import { resolveVerifiedUserPrincipalScope } from '@/shared/utils/identity/verified-principal-scope.util.js';

describe('UserDataExportService (database)', () => {
  const service = createDomainContainers(createObjectStoragePortMock()).userDomain
    .userDataExportService;

  beforeEach(async () => {
    await cleanupDatabase();
    await seedPermissions([TENANCY_PERMISSIONS.ORGANIZATION_READ]);
  });

  it('buildExportPayload aggregates user, organization, notification, and audit data', async () => {
    const user = await createTestUser({
      email: 'export@example.com',
      firstName: 'Export',
      lastName: '',
    });
    const organization = await createTestOrganization({
      ownerUserId: user.id,
      name: 'Export Org',
      slug: 'export-org',
    });
    const membershipRole = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [TENANCY_PERMISSIONS.ORGANIZATION_READ],
    });
    await createMembership({
      userId: user.id,
      organizationId: organization.id,
      roleId: membershipRole.id,
    });

    const notificationRepository = new NotificationRepository();
    await notificationRepository.create({
      user_id: user.id,
      organization_id: organization.id,
      type: 'BILLING',
      title: 'Usage',
      message: 'Updated',
    });

    const auditRepository = new AuditRepository();
    await auditRepository.insert({
      actor_user_id: user.id,
      action: 'user.login',
      resource_type: 'user',
      resource_id: user.id,
    });

    const exported = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(user.public_id),
      () => service.buildExportPayload(user.public_id),
    );

    expect(exported.user.email).toBe('export@example.com');
    expect(exported.user.full_name).toBe('Export');
    expect(exported.sessions).toEqual([]);
    expect(
      exported.organizations.some(
        (membership: { slug: string | null }) => membership.slug === organization.slug,
      ),
    ).toBe(true);
    expect(exported.notifications).toHaveLength(1);
    expect(exported.audit_activity).toHaveLength(1);
    expect(exported.exported_at).toBeTruthy();
  });

  it('buildExportPayload throws when user is missing', async () => {
    await expect(
      withPrincipalDatabaseContext(resolveVerifiedUserPrincipalScope('missing_public_id'), () =>
        service.buildExportPayload('missing_public_id'),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('buildExportPayload includes session activity for the user', async () => {
    const user = await createTestUser({ email: 'export-sessions@example.com' });
    await database.insert(sessions).values({
      public_id: generatePublicId('userDataExport'),
      user_id: user.id,
      token_hash: 'a'.repeat(64),
      ip_address: '203.0.113.10',
      expires_at: new Date(Date.now() + 60_000),
    });

    const exported = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(user.public_id),
      () => service.buildExportPayload(user.public_id),
    );

    expect(exported.sessions).toHaveLength(1);
    expect(exported.sessions[0]?.ip_address).toBe('203.0.113.10');
  });

  it('buildExportPayload returns null full_name when profile names are empty', async () => {
    const user = await createTestUser({
      email: 'noname@example.com',
      firstName: '',
      lastName: '',
    });

    const exported = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(user.public_id),
      () => service.buildExportPayload(user.public_id),
    );

    expect(exported.user.full_name).toBeNull();
    expect(exported.organizations).toEqual([]);
    expect(exported.notifications).toEqual([]);
    expect(exported.audit_activity).toEqual([]);
  });
});
