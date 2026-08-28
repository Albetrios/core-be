import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditService } from '@/domains/audit/audit.service.js';
import type { AuditRepository } from '@/domains/audit/audit.repository.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { UserService } from '@/domains/user/user.service.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { withAppDatabaseContext } from '@/infrastructure/database/contexts/database-context.js';

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Dispatch per kind so the per-context spies keep their original assertions.
    withMaintenanceDatabaseContext: vi.fn((scope: { kind: string }, ...parameters: unknown[]) => {
      const inner = (scope.kind === 'global_admin'
        ? globalAdminContextMock
        : systemAuditInsertContextMock) as unknown as (...innerParameters: unknown[]) => unknown;
      return inner(...parameters);
    }),
    withAppDatabaseContext: vi.fn((_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

vi.mock('@/infrastructure/observability/sentry/sentry.js', () => ({
  captureMessage: vi.fn(),
}));

const insertAuditOutboxRowMock = vi.hoisted(() => vi.fn().mockResolvedValue(1));

/**
 * P0-#2 (audit outbox): `AuditService.record` now writes to `audit.outbox` via
 * `insertAuditOutboxRow` instead of opening a new transaction and inserting into
 * `audit.logs` directly. Mock the outbox repo so tests stay synchronous and we can
 * assert the staged payload's shape directly.
 */
vi.mock('@/domains/audit/audit-outbox.repository.js', () => ({
  insertAuditOutboxRow: (...args: unknown[]) => insertAuditOutboxRowMock(...args),
}));

/**
 * `listForOrganization`/`listForAdmin` still use the DB context wrappers — mock them
 * to invoke the inner callback so the tests run without Postgres.
 */

const globalAdminContextMock = vi.hoisted(() =>
  vi.fn((callback: () => Promise<unknown>) => callback()),
);

// sec-R10: tenantless audit rows now reserve their outbox slot under the system-audit-insert
// context. The unit test just runs the callback (the RLS gate is exercised in the security suite).
const systemAuditInsertContextMock = vi.hoisted(() =>
  vi.fn((callback: () => Promise<unknown>) => callback()),
);

describe('AuditService', () => {
  const repository = {
    insert: vi.fn().mockResolvedValue(undefined),
    findWithFilters: vi.fn().mockResolvedValue({
      items: [{ action: 'user.login' }],
      total: 1,
      hasMore: false,
      nextCursor: null,
    }),
    resolveUserPublicIdsByInternalIds: vi.fn().mockResolvedValue(new Map()),
    resolveOrganizationPublicIdsByInternalIds: vi.fn().mockResolvedValue(new Map()),
  } as unknown as AuditRepository;

  const organizationService = {
    findOrganizationByPublicId: vi.fn().mockResolvedValue({ id: 10, public_id: 'org_public' }),
    findOrganizationByInternalId: vi.fn().mockResolvedValue({ id: 10, public_id: 'org_public' }),
  } as unknown as OrganizationService;

  const userService = {
    findUserRecordByPublicId: vi.fn().mockResolvedValue({ id: 5, public_id: 'user_public' }),
  } as unknown as UserService;

  const service = new AuditService(repository, organizationService, userService);

  beforeEach(() => {
    vi.clearAllMocks();
    insertAuditOutboxRowMock.mockResolvedValue(1);
  });

  describe('record (outbox path)', () => {
    it('stages a row with the user actor public id and no per-row transaction', async () => {
      await service.record({
        actorUserPublicId: 'user_public',
        action: 'user.login',
        resource_type: 'user',
        organization_public_id: 'org_public',
        ip_address: '203.0.113.10',
        user_agent: 'test-agent/1.0',
        metadata: { sessionId: 'sess_1' },
      });

      expect(insertAuditOutboxRowMock).toHaveBeenCalledExactlyOnceWith({
        actorUserPublicId: 'user_public',
        actorApiKeyPublicId: undefined,
        targetUserPublicId: undefined,
        organizationPublicId: 'org_public',
        action: 'user.login',
        resourceType: 'user',
        resourceId: null,
        ipAddress: '203.0.113.10',
        userAgent: 'test-agent/1.0',
        severity: 'INFO',
        metadata: { sessionId: 'sess_1' },
      });
      // Old path opened a new transaction per row — outbox path must not.
      expect(repository.insert).not.toHaveBeenCalled();
    });

    it('stages a row attributed to an API key when no user actor is present', async () => {
      await service.record({
        actorApiKeyPublicId: 'key_public',
        action: 'tenancy.role.create',
        resource_type: 'role',
        organization_public_id: 'org_public',
      });

      expect(insertAuditOutboxRowMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          actorApiKeyPublicId: 'key_public',
          actorUserPublicId: undefined,
          organizationPublicId: 'org_public',
          action: 'tenancy.role.create',
        }),
      );
    });

    it('preserves target_user_public_id and resource_id on the staged row', async () => {
      await service.record({
        actorUserPublicId: 'admin_public',
        target_user_public_id: 'victim_public',
        action: 'user.locked',
        resource_type: 'user',
        resource_id: 42,
        severity: 'WARNING',
        organization_public_id: 'org_public',
      });

      expect(insertAuditOutboxRowMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          actorUserPublicId: 'admin_public',
          targetUserPublicId: 'victim_public',
          resourceId: 42,
          severity: 'WARNING',
        }),
      );
    });

    it('R10: org-scoped rows reserve the outbox slot under organization RLS context', async () => {
      await service.record({
        actorUserPublicId: 'user_public',
        action: 'tenancy.role.create',
        resource_type: 'role',
        organization_public_id: 'org_public',
      });
      // Without this context the outbox WITH CHECK rejects the INSERT under core_be_app.
      expect(vi.mocked(withAppDatabaseContext)).toHaveBeenCalledWith(
        expect.objectContaining({ organizationPublicId: 'org_public' }),
        expect.any(Function),
      );
      expect(systemAuditInsertContextMock).not.toHaveBeenCalled();
    });

    it('R10: tenantless rows reserve the outbox slot under the system-audit-insert context', async () => {
      await service.record({
        actorUserPublicId: 'user_public',
        action: 'user.login',
        resource_type: 'user',
      });
      expect(systemAuditInsertContextMock).toHaveBeenCalledTimes(1);
      expect(vi.mocked(withAppDatabaseContext)).not.toHaveBeenCalled();
    });

    it('skips outbox INSERT when neither user nor API-key actor is supplied', async () => {
      await service.record({
        action: 'tenancy.role.create',
        resource_type: 'role',
        organization_public_id: 'org_public',
      });

      expect(insertAuditOutboxRowMock).not.toHaveBeenCalled();
    });

    it('does NOT swallow a DB INSERT failure — caller wrappers (recordAuditEvent) must handle it', async () => {
      // The previous path swallowed DB errors silently inside the org DB context;
      // the outbox path propagates so `recordAuditEvent` catches + logs, preserving the
      // "audit never fails the request" contract at the wrapper level (not the service).
      insertAuditOutboxRowMock.mockRejectedValueOnce(new Error('outbox-rls-rejected'));

      await expect(
        service.record({
          actorUserPublicId: 'user_public',
          action: 'user.login',
          resource_type: 'user',
        }),
      ).rejects.toThrow(/outbox-rls-rejected/);
    });
  });

  describe('list (read path unchanged)', () => {
    it('resolves organization and actor filters', async () => {
      const organizationPublicId = generatePublicId('organization');
      const actorPublicId = generatePublicId('user');
      const result = await service.list({
        limit: 20,
        organization_id: organizationPublicId,
        actor_user_id: actorPublicId,
        resource_type: 'user',
        action: 'user.login',
      });
      expect(repository.findWithFilters).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: 10,
          actor_user_id: 5,
          resource_type: 'user',
          action: 'user.login',
          limit: 20,
        }),
      );
      expect(result.total).toBe(1);
      expect(result.next_cursor).toBeNull();
    });

    it('returns empty page when organization public id is unknown without total by default', async () => {
      vi.mocked(organizationService.findOrganizationByPublicId).mockResolvedValue(null);
      const result = await service.list({
        limit: 20,
        organization_id: generatePublicId('organization'),
      });
      expect(repository.findWithFilters).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        items: [],
        total: null,
        limit: 20,
        has_more: false,
        next_cursor: null,
      });
    });

    it('returns empty page with total zero when organization public id is unknown and include_total=true', async () => {
      vi.mocked(organizationService.findOrganizationByPublicId).mockResolvedValue(null);
      const result = await service.list({
        limit: 20,
        organization_id: generatePublicId('organization'),
        include_total: 'true',
      });
      expect(repository.findWithFilters).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        items: [],
        total: 0,
        limit: 20,
        has_more: false,
        next_cursor: null,
      });
    });

    it('returns empty page when actor public id is unknown without total by default', async () => {
      vi.mocked(userService.findUserRecordByPublicId).mockResolvedValue(null);
      const result = await service.list({ limit: 20, actor_user_id: generatePublicId('user') });
      expect(repository.findWithFilters).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        items: [],
        total: null,
        limit: 20,
        has_more: false,
        next_cursor: null,
      });
    });

    it('returns empty page with total zero when actor public id is unknown and include_total=true', async () => {
      vi.mocked(userService.findUserRecordByPublicId).mockResolvedValue(null);
      const result = await service.list({
        limit: 20,
        actor_user_id: generatePublicId('user'),
        include_total: 'true',
      });
      expect(repository.findWithFilters).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        items: [],
        total: 0,
        limit: 20,
        has_more: false,
        next_cursor: null,
      });
    });

    it('returns empty page when no rows', async () => {
      vi.mocked(repository.findWithFilters).mockResolvedValue({
        items: [],
        total: 0,
        hasMore: false,
        nextCursor: null,
      });
      const result = await service.list({ limit: 20 });
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('listForAdmin runs the listing inside the global-admin RLS context', async () => {
      vi.mocked(repository.findWithFilters).mockResolvedValue({
        items: [{ action: 'user.login' }],
        total: 1,
        hasMore: false,
        nextCursor: null,
      } as never);
      const result = await service.listForAdmin({ limit: 20 });
      expect(globalAdminContextMock).toHaveBeenCalledTimes(1);
      expect(repository.findWithFilters).toHaveBeenCalled();
      expect(result.total).toBe(1);
    });

    it('skips the total when include_total=false and derives has_more', async () => {
      vi.mocked(repository.findWithFilters).mockResolvedValue({
        items: [{ action: 'user.login' }],
        total: null,
        hasMore: true,
        nextCursor: 'cursor_2',
      } as never);
      const result = await service.list({ limit: 20, include_total: 'false' });
      expect(repository.findWithFilters).toHaveBeenCalledWith(
        expect.objectContaining({ include_total: false }),
      );
      expect(result.total).toBeNull();
      expect(result.has_more).toBe(true);
      expect(result.next_cursor).toBe('cursor_2');
    });
  });
});
