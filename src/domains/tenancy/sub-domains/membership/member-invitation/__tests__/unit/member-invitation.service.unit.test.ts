import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/domains/tenancy/sub-domains/permission/permission-cache.service.js', () => ({
  invalidatePermissions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/core/events/event-bus.js', () => ({
  eventBus: {
    emit: vi.fn().mockResolvedValue(undefined),
    emitStrict: vi.fn().mockResolvedValue(undefined),
  },
  buildDomainEvent: (type: string, payload: unknown, options?: { requestId?: string }) => ({
    type,
    payload,
    timestamp: new Date(),
    ...(options?.requestId !== undefined ? { requestId: options.requestId } : {}),
  }),
}));

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
    withAppDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

vi.mock(
  '@/domains/tenancy/sub-domains/membership/member-invitation/member-invitation.token.js',
  () => ({
    generateInvitationToken: vi.fn().mockReturnValue('raw-token-abc123'),
    hashInvitationToken: vi.fn().mockReturnValue('hashed-token-abc123'),
  }),
);

import { NotFoundError, ValidationError } from '@/shared/errors/index.js';
import { MemberInvitationService } from '@/domains/tenancy/sub-domains/membership/member-invitation/member-invitation.service.js';
import { eventBus } from '@/core/events/event-bus.js';
import type { OrganizationRepository } from '@/domains/tenancy/sub-domains/organization/organization.repository.js';
import type { MembershipRepository } from '@/domains/tenancy/sub-domains/membership/membership.repository.js';
import type { MemberInvitationRepository } from '@/domains/tenancy/sub-domains/membership/member-invitation/member-invitation.repository.js';
import type { UserService } from '@/domains/user/user.service.js';
import {
  PRINCIPAL_SCOPE,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

const now = new Date('2026-06-01T00:00:00.000Z');
const futureDate = new Date('2026-06-15T00:00:00.000Z');
const organization = { id: 1, public_id: 'org_public_abc', name: 'Test Org' };
const membership = { id: 10, public_id: 'mem_public_xyz', organization_id: 1, user_id: 5 };

function makeInvitationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    public_id: 'inv_public_123',
    membership_id: 10,
    email: 'invitee@example.com',
    token_hash: 'hashed-token-abc123',
    invited_by_user_id: 2,
    expires_at: futureDate,
    accepted_at: null,
    revoked_at: null,
    created_at: now,
    ...overrides,
  };
}

const asScope = (organizationPublicId: string) =>
  PRINCIPAL_SCOPE.REQUEST({
    organizationPublicId,
  }) as OrganizationPrincipalDatabaseScope;

describe('MemberInvitationService', () => {
  const organizationRepository = {
    findByPublicId: vi.fn().mockResolvedValue(organization),
    resolveUserPublicIdByInternalId: vi.fn().mockResolvedValue('user_public_id'),
  } as unknown as OrganizationRepository;

  const membershipRepository = {
    findById: vi.fn().mockResolvedValue(membership),
    activateForInvitationAccept: vi.fn().mockResolvedValue(membership),
    softDelete: vi.fn().mockResolvedValue(membership),
    // item #10: accept() resolves membership:manage holders for the invite-accepted notification;
    // default to none so these lifecycle tests don't emit (the fan-out is covered by its own suites).
    findUserIdsWithPermission: vi.fn().mockResolvedValue([]),
  } as unknown as MembershipRepository;

  const invitationRepository = {
    findByPublicId: vi.fn().mockResolvedValue(makeInvitationRow()),
    lookupOrganizationByInvitationPublicId: vi.fn().mockResolvedValue({
      organization_public_id: 'org_public_abc',
      organization_id: 1,
      membership_id: 10,
      membership_public_id: 'mem_public_xyz',
    }),
    create: vi.fn().mockResolvedValue(makeInvitationRow()),
    // item #E: createForMembership takes the per-organization pending-invitation quota lock + count before insert.
    acquireCreationQuotaLock: vi.fn().mockResolvedValue(undefined),
    countPendingByOrganization: vi.fn().mockResolvedValue(0),
    accept: vi.fn().mockResolvedValue(makeInvitationRow({ accepted_at: now })),
    revoke: vi.fn().mockResolvedValue(makeInvitationRow({ revoked_at: now })),
    resend: vi.fn().mockResolvedValue(makeInvitationRow()),
  } as unknown as MemberInvitationRepository;

  const userService = {
    // sec-T4: accept requires the acting user's email to match the invitee email.
    requireUserRecordByPublicId: vi.fn().mockResolvedValue({
      id: 5,
      public_id: 'user_public_id',
      email: 'invitee@example.com',
      is_email_verified: true,
    }),
  } as unknown as UserService;

  const service = new MemberInvitationService(
    organizationRepository,
    membershipRepository,
    invitationRepository,
    userService,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    // Pin the clock so the fixed `expires_at` fixture never lapses against the real wall clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    vi.mocked(organizationRepository.findByPublicId).mockResolvedValue(organization as never);
    vi.mocked(organizationRepository.resolveUserPublicIdByInternalId).mockResolvedValue(
      'user_public_id',
    );
    vi.mocked(membershipRepository.findById).mockResolvedValue(membership as never);
    vi.mocked(membershipRepository.activateForInvitationAccept).mockResolvedValue(
      membership as never,
    );
    vi.mocked(membershipRepository.softDelete).mockResolvedValue(membership as never);
    vi.mocked(invitationRepository.findByPublicId).mockResolvedValue(makeInvitationRow() as never);
    vi.mocked(invitationRepository.lookupOrganizationByInvitationPublicId).mockResolvedValue({
      organization_public_id: 'org_public_abc',
      organization_id: 1,
      membership_id: 10,
      membership_public_id: 'mem_public_xyz',
    } as never);
    vi.mocked(invitationRepository.create).mockResolvedValue(makeInvitationRow() as never);
    vi.mocked(invitationRepository.accept).mockResolvedValue(
      makeInvitationRow({ accepted_at: now }) as never,
    );
    vi.mocked(invitationRepository.revoke).mockResolvedValue(
      makeInvitationRow({ revoked_at: now }) as never,
    );
    vi.mocked(invitationRepository.resend).mockResolvedValue(makeInvitationRow() as never);
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue({
      id: 5,
      public_id: 'user_public_id',
      email: 'invitee@example.com',
      is_email_verified: true,
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createForMembership', () => {
    const params = {
      organization_name: 'Test Org',
      organization_id: 1,
      membership_id: 10,
      membership_public_id: 'mem_public_xyz',
      email: 'invitee@example.com',
      expires_in_days: 7,
      invited_by_user_id: 2,
      inviter_label: 'inviter_public',
    };

    it('creates the invitation and emits a strict event without returning the token (R1/R2)', async () => {
      const result = await service.createForMembership(params);
      expect(invitationRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          membership_id: 10,
          email: 'invitee@example.com',
          invited_by_user_id: 2,
          token_hash: 'hashed-token-abc123',
        }),
      );
      // R2: credential distribution uses emitStrict so a failed outbox write fails the request.
      expect(eventBus.emitStrict).toHaveBeenCalledOnce();
      expect(eventBus.emit).not.toHaveBeenCalled();
      // R1: the raw token is never part of the returned shape.
      expect(result).toMatchObject({ id: 'inv_public_123' });
      expect((result as unknown as Record<string, unknown>).token).toBeUndefined();
    });

    it('throws ConflictError and does not insert when the organization is at the pending-invitation cap', async () => {
      // Well above any configured INVITATION_MAX_PENDING_PER_ORG (max 1000) so the cap always trips.
      vi.mocked(invitationRepository.countPendingByOrganization).mockResolvedValueOnce(100_000);
      await expect(service.createForMembership(params)).rejects.toMatchObject({
        name: 'ConflictError',
      });
      // The advisory lock is taken (keyed by the organization id) before the count, and no row is inserted.
      expect(invitationRepository.acquireCreationQuotaLock).toHaveBeenCalledWith(1);
      expect(invitationRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('accept', () => {
    const body = { token: 'raw-token-abc123' };

    it('accepts invitation and activates membership', async () => {
      const result = await service.accept('inv_public_123', body, 'user_public_id');
      expect(invitationRepository.accept).toHaveBeenCalled();
      expect(membershipRepository.activateForInvitationAccept).toHaveBeenCalled();
      expect(result).toMatchObject({ email: 'invitee@example.com' });
    });

    it('throws ForbiddenError when acting user email does not match invitee (sec-T4)', async () => {
      vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValueOnce({
        id: 99,
        public_id: 'user_attacker',
        email: 'attacker@example.com',
        is_email_verified: true,
      } as never);
      await expect(service.accept('inv_public_123', body, 'user_attacker')).rejects.toMatchObject({
        name: 'ForbiddenError',
      });
    });

    it('throws ForbiddenError when the acting user email is not verified (sec-T4 follow-up)', async () => {
      vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValueOnce({
        id: 5,
        public_id: 'user_public_id',
        email: 'invitee@example.com',
        is_email_verified: false,
      } as never);
      await expect(service.accept('inv_public_123', body, 'user_public_id')).rejects.toMatchObject({
        name: 'ForbiddenError',
      });
      // The unverified caller is rejected before the invitation row is even consumed.
      expect(invitationRepository.accept).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when lookup returns null', async () => {
      vi.mocked(invitationRepository.lookupOrganizationByInvitationPublicId).mockResolvedValue(
        null,
      );
      await expect(service.accept('missing_inv', body, 'user_public_id')).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('throws NotFoundError when invitation row is missing', async () => {
      vi.mocked(invitationRepository.findByPublicId).mockResolvedValue(null);
      await expect(service.accept('inv_public_123', body, 'user_public_id')).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('throws ValidationError when invitation is already revoked', async () => {
      vi.mocked(invitationRepository.findByPublicId).mockResolvedValue(
        makeInvitationRow({ revoked_at: now }) as never,
      );
      await expect(service.accept('inv_public_123', body, 'user_public_id')).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('throws ValidationError when invitation is already accepted', async () => {
      vi.mocked(invitationRepository.findByPublicId).mockResolvedValue(
        makeInvitationRow({ accepted_at: now }) as never,
      );
      await expect(service.accept('inv_public_123', body, 'user_public_id')).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('throws ValidationError when invitation is expired', async () => {
      vi.mocked(invitationRepository.findByPublicId).mockResolvedValue(
        makeInvitationRow({ expires_at: new Date('2020-01-01T00:00:00.000Z') }) as never,
      );
      await expect(service.accept('inv_public_123', body, 'user_public_id')).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  describe('revoke', () => {
    it('revokes the invitation', async () => {
      await service.revoke(asScope('org_public_abc'), 'inv_public_123');
      expect(invitationRepository.revoke).toHaveBeenCalledWith('inv_public_123');
    });

    it('soft-deletes the auto-created INVITED membership so no ghost invitee remains (REQ-1)', async () => {
      await service.revoke(asScope('org_public_abc'), 'inv_public_123');
      expect(membershipRepository.softDelete).toHaveBeenCalledWith('mem_public_xyz', 1);
    });

    it('throws NotFoundError when organization is missing', async () => {
      vi.mocked(organizationRepository.findByPublicId).mockResolvedValue(null);
      await expect(
        service.revoke(asScope('org_public_abc'), 'inv_public_123'),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('throws NotFoundError when invitation is missing', async () => {
      vi.mocked(invitationRepository.findByPublicId).mockResolvedValue(null);
      await expect(
        service.revoke(asScope('org_public_abc'), 'inv_public_123'),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('throws NotFoundError when revoke returns null', async () => {
      vi.mocked(invitationRepository.revoke).mockResolvedValue(null);
      await expect(
        service.revoke(asScope('org_public_abc'), 'inv_public_123'),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('resend', () => {
    const body = { expires_in_days: 7 };

    it('resends invitation with a new token via strict event, without returning it (R1/R2)', async () => {
      const result = await service.resend(asScope('org_public_abc'), 'inv_public_123', body);
      expect(invitationRepository.resend).toHaveBeenCalled();
      expect(eventBus.emitStrict).toHaveBeenCalledOnce();
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(result).toMatchObject({ id: 'inv_public_123' });
      expect((result as unknown as Record<string, unknown>).token).toBeUndefined();
    });

    it('throws NotFoundError when invitation is missing', async () => {
      vi.mocked(invitationRepository.findByPublicId).mockResolvedValue(null);
      await expect(
        service.resend(asScope('org_public_abc'), 'inv_public_123', body),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('throws ValidationError when invitation is already accepted', async () => {
      vi.mocked(invitationRepository.findByPublicId).mockResolvedValue(
        makeInvitationRow({ accepted_at: now }) as never,
      );
      await expect(
        service.resend(asScope('org_public_abc'), 'inv_public_123', body),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError when invitation is revoked', async () => {
      vi.mocked(invitationRepository.findByPublicId).mockResolvedValue(
        makeInvitationRow({ revoked_at: now }) as never,
      );
      await expect(
        service.resend(asScope('org_public_abc'), 'inv_public_123', body),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError and neither rotates the token nor emits when the invitation is expired', async () => {
      vi.mocked(invitationRepository.findByPublicId).mockResolvedValue(
        makeInvitationRow({ expires_at: new Date('2020-01-01T00:00:00.000Z') }) as never,
      );
      await expect(
        service.resend(asScope('org_public_abc'), 'inv_public_123', body),
      ).rejects.toBeInstanceOf(ValidationError);
      // The expiry guard must fire BEFORE the destructive token rotation: `resend` overwrites the
      // token_hash in place, so rotating for an already-expired invite would invalidate the
      // invitee's link while still refusing the operation. No rotation, no outbox event.
      expect(invitationRepository.resend).not.toHaveBeenCalled();
      expect(eventBus.emitStrict).not.toHaveBeenCalled();
    });
  });
});
