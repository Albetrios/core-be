import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError, ValidationError } from '@/shared/errors/index.js';
import { UserNotificationPreferencesService } from '@/domains/user/sub-domains/user-notification-preferences/user-notification-preferences.service.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { UserNotificationPreferencesRepository } from '@/domains/user/sub-domains/user-notification-preferences/user-notification-preferences.repository.js';
import {
  createPrincipalDatabaseScope,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/principal-database.context.js';

vi.mock('@/infrastructure/database/contexts/user-database.context.js', () => ({
  withUserDatabaseContext: vi.fn((_userPublicId: string, callback: () => Promise<unknown>) =>
    callback(),
  ),
}));

vi.mock('@/infrastructure/database/contexts/request-database.context.js', () => ({
  getOrganizationRequestDatabaseSession: vi.fn().mockReturnValue(undefined),
}));

vi.mock('@/infrastructure/database/transaction.js', () => ({
  withAtomicWrite: vi.fn((_callback: (databaseHandle: unknown) => Promise<unknown>) =>
    _callback({}),
  ),
}));

vi.mock(
  '@/infrastructure/database/contexts/principal-database.context.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      withPrincipalDatabaseContext: vi.fn(
        async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
      ),
    };
  },
);

const user = { id: 1, public_id: 'user_public', email: 'user@example.com' };
const preferenceRow = {
  id: 2,
  notification_type: 'subscription.updated',
  channel: 'EMAIL',
  organization_id: null,
  is_enabled: true,
};

const asUserScope = (userPublicId: string) =>
  createPrincipalDatabaseScope({
    userPublicId,
    organizationPublicId: 'org_scope_test',
    source: 'token',
  }) as UserPrincipalDatabaseScope;

describe('UserNotificationPreferencesService', () => {
  const userService = {
    findUserRecordByPublicId: vi.fn().mockResolvedValue(user),
  } as unknown as UserService;

  const preferencesRepository = {
    listByUserId: vi.fn().mockResolvedValue([preferenceRow]),
    replaceAll: vi.fn().mockResolvedValue([preferenceRow]),
  } as unknown as UserNotificationPreferencesRepository;

  const service = new UserNotificationPreferencesService(userService, preferencesRepository);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userService.findUserRecordByPublicId).mockResolvedValue(user as never);
    vi.mocked(preferencesRepository.replaceAll).mockResolvedValue([preferenceRow] as never);
    vi.mocked(preferencesRepository.listByUserId).mockResolvedValue([preferenceRow] as never);
  });

  it('get returns preferences for user', async () => {
    const result = await service.get(asUserScope('user_public'));
    expect(result).toHaveLength(1);
    expect(result[0]?.notification_type).toBe('subscription.updated');
  });

  it('get throws when user missing', async () => {
    vi.mocked(userService.findUserRecordByPublicId).mockResolvedValue(null);
    await expect(service.get(asUserScope('missing'))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('put throws when user missing', async () => {
    vi.mocked(userService.findUserRecordByPublicId).mockResolvedValue(null);
    await expect(
      service.put(asUserScope('missing'), {
        preferences: [
          { notification_type: 'subscription.updated', channel: 'EMAIL', is_enabled: true },
        ],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('put rejects organization-scoped preferences (org_id is unsettable on this user-scoped endpoint)', async () => {
    // This user-scoped endpoint has no tenant context, so a non-null organization_id can never
    // satisfy the org RLS branch (would surface as 42501 -> 500). It must be rejected with a 400
    // before reaching the repository.
    await expect(
      service.put(asUserScope('user_public'), {
        preferences: [
          {
            notification_type: 'subscription.updated',
            channel: 'EMAIL',
            organization_id: 1,
            is_enabled: true,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(preferencesRepository.replaceAll).not.toHaveBeenCalled();
  });

  it('put persists user-wide preferences when organization_id is omitted', async () => {
    await service.put(asUserScope('user_public'), {
      preferences: [
        { notification_type: 'subscription.updated', channel: 'EMAIL', is_enabled: true },
      ],
    });

    expect(preferencesRepository.replaceAll).toHaveBeenCalledWith(
      user.id,
      [
        {
          notification_type: 'subscription.updated',
          channel: 'EMAIL',
          organization_id: null,
          is_enabled: true,
        },
      ],
      user.id,
    );
  });

  it('put returns empty list when replaceAll returns no rows', async () => {
    vi.mocked(preferencesRepository.replaceAll).mockResolvedValue([]);
    const result = await service.put(asUserScope('user_public'), {
      preferences: [
        { notification_type: 'subscription.updated', channel: 'EMAIL', is_enabled: false },
      ],
    });
    expect(result).toEqual([]);
  });

  it('put replaces preferences for user', async () => {
    const result = await service.put(asUserScope('user_public'), {
      preferences: [
        {
          notification_type: 'subscription.updated',
          channel: 'EMAIL',
          is_enabled: false,
        },
      ],
    });
    expect(preferencesRepository.replaceAll).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0]?.is_enabled).toBe(true);
  });
});
