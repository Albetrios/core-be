import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withPrincipalDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

const { i18nLocaleCacheSpies } = vi.hoisted(() => ({
  i18nLocaleCacheSpies: {
    get: vi.fn(),
    set: vi.fn(),
    invalidate: vi.fn(),
  },
}));

vi.mock(
  '@/domains/tenancy/sub-domains/organization/organization-settings/i18n-locale.cache.js',
  () => ({
    getCachedOrganizationDefaultLocale: i18nLocaleCacheSpies.get,
    setCachedOrganizationDefaultLocale: i18nLocaleCacheSpies.set,
    invalidateCachedOrganizationDefaultLocale: i18nLocaleCacheSpies.invalidate,
  }),
);

import { NotFoundError } from '@/shared/errors/index.js';
import {
  createPrincipalDatabaseScope,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import { OrganizationSettingsService } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.service.js';
import type { OrganizationRepository } from '@/domains/tenancy/sub-domains/organization/organization.repository.js';
import type { OrganizationSettingsRepository } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.repository.js';

const now = new Date('2026-01-01T00:00:00.000Z');
const organization = { id: 1, public_id: 'org_public_abc', name: 'Test Org' };
const scope = createPrincipalDatabaseScope({
  userPublicId: 'user_public',
  organizationPublicId: 'org_public_abc',
  source: 'token',
}) as OrganizationPrincipalDatabaseScope;
const settingsRow = {
  is_email_notifications_enabled: true,
  default_locale: 'en',
  security_policy: {},
  created_at: now,
  updated_at: now,
};

describe('OrganizationSettingsService', () => {
  const organizationRepository = {
    findByPublicId: vi.fn().mockResolvedValue(organization),
    resolveUserIdByPublicId: vi.fn().mockResolvedValue(10),
  } as unknown as OrganizationRepository;

  const settingsRepository = {
    findByOrganizationId: vi.fn().mockResolvedValue(settingsRow),
    upsert: vi.fn().mockResolvedValue(settingsRow),
    findDefaultLocaleByOrganizationPublicId: vi.fn().mockResolvedValue('en'),
    userHasOrganizationRequiringMfa: vi.fn().mockResolvedValue(false),
  } as unknown as OrganizationSettingsRepository;

  const service = new OrganizationSettingsService(organizationRepository, settingsRepository);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(organizationRepository.findByPublicId).mockResolvedValue(organization as never);
    vi.mocked(settingsRepository.findByOrganizationId).mockResolvedValue(settingsRow as never);
    vi.mocked(settingsRepository.upsert).mockResolvedValue(settingsRow as never);
    vi.mocked(settingsRepository.findDefaultLocaleByOrganizationPublicId).mockResolvedValue('en');
    vi.mocked(settingsRepository.userHasOrganizationRequiringMfa).mockResolvedValue(false);
  });

  describe('get', () => {
    it('returns serialized settings when row exists', async () => {
      const result = await service.get(scope);
      expect(result).toMatchObject({
        organization_id: 'org_public_abc',
        is_email_notifications_enabled: true,
        default_locale: 'en',
      });
    });

    it('upserts and returns defaults when settings row is missing', async () => {
      vi.mocked(settingsRepository.findByOrganizationId).mockResolvedValue(null);
      await service.get(scope);
      expect(settingsRepository.upsert).toHaveBeenCalledWith(organization.id, {});
    });

    it('throws NotFoundError when organization is missing', async () => {
      vi.mocked(organizationRepository.findByPublicId).mockResolvedValue(null);
      await expect(service.get(scope)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('propagates repository errors', async () => {
      vi.mocked(settingsRepository.findByOrganizationId).mockRejectedValue(
        new Error('DB connection failed'),
      );
      await expect(service.get(scope)).rejects.toThrow('DB connection failed');
    });
  });

  describe('update', () => {
    it('validates and upserts settings with provided fields', async () => {
      const result = await service.update(
        scope,
        { is_email_notifications_enabled: false },
        'user_public',
      );
      expect(settingsRepository.upsert).toHaveBeenCalledWith(
        organization.id,
        expect.objectContaining({ is_email_notifications_enabled: false }),
      );
      expect(result).toMatchObject({ organization_id: 'org_public_abc' });
    });

    it('throws NotFoundError when organization is missing', async () => {
      vi.mocked(organizationRepository.findByPublicId).mockResolvedValue(null);
      await expect(service.update(scope, {}, 'user_public')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('propagates upsert errors', async () => {
      vi.mocked(settingsRepository.upsert).mockRejectedValue(new Error('Upsert failed'));
      await expect(service.update(scope, {}, 'user_public')).rejects.toThrow('Upsert failed');
    });
  });

  describe('resolveDefaultLocaleForOrganization', () => {
    beforeEach(() => {
      // Default: cache miss, so the test exercises the DB resolve path.
      i18nLocaleCacheSpies.get.mockResolvedValue(null);
      i18nLocaleCacheSpies.set.mockResolvedValue(undefined);
      i18nLocaleCacheSpies.invalidate.mockResolvedValue(undefined);
    });

    it('returns configured locale when set', async () => {
      const locale = await service.resolveDefaultLocaleForOrganization('org_public_abc');
      expect(locale).toBe('en');
    });

    it('falls back to "en" when locale is null', async () => {
      vi.mocked(settingsRepository.findDefaultLocaleByOrganizationPublicId).mockResolvedValue(null);
      const locale = await service.resolveDefaultLocaleForOrganization('org_public_abc');
      expect(locale).toBe('en');
    });

    // sec-M1: cache hit must short-circuit the DB call entirely so an
    // attacker spamming pre-auth requests with an `X-Organization-Id` header
    // cannot drive thousands of Postgres lookups per second.
    it('returns the cached locale and skips the DB when cache hits (sec-M1)', async () => {
      i18nLocaleCacheSpies.get.mockResolvedValueOnce('es');

      const locale = await service.resolveDefaultLocaleForOrganization('org_public_abc');

      expect(locale).toBe('es');
      expect(settingsRepository.findDefaultLocaleByOrganizationPublicId).not.toHaveBeenCalled();
      // No need to re-cache a value we already read out of the cache.
      expect(i18nLocaleCacheSpies.set).not.toHaveBeenCalled();
    });

    it('caches the freshly-resolved locale on a miss so subsequent calls do not hit the DB', async () => {
      i18nLocaleCacheSpies.get.mockResolvedValueOnce(null);
      vi.mocked(settingsRepository.findDefaultLocaleByOrganizationPublicId).mockResolvedValueOnce(
        'es',
      );

      await service.resolveDefaultLocaleForOrganization('org_public_abc');

      expect(i18nLocaleCacheSpies.set).toHaveBeenCalledWith('org_public_abc', 'es');
    });

    it('caches the "en" fallback so unknown org ids stop hitting the DB after the first lookup', async () => {
      i18nLocaleCacheSpies.get.mockResolvedValueOnce(null);
      vi.mocked(settingsRepository.findDefaultLocaleByOrganizationPublicId).mockResolvedValueOnce(
        null,
      );

      await service.resolveDefaultLocaleForOrganization('org_unknown');

      // The negative cache stops the existence-oracle path: every subsequent
      // request for the same unknown org returns 'en' from Redis without
      // ever touching the SECURITY DEFINER function.
      expect(i18nLocaleCacheSpies.set).toHaveBeenCalledWith('org_unknown', 'en');
    });
  });

  describe('update — sec-M1 cache invalidation', () => {
    it('invalidates the i18n locale cache when default_locale is changed', async () => {
      await service.update(scope, { default_locale: 'es' }, undefined);
      expect(i18nLocaleCacheSpies.invalidate).toHaveBeenCalledWith('org_public_abc');
    });

    it('does NOT invalidate when default_locale is absent from the patch', async () => {
      i18nLocaleCacheSpies.invalidate.mockClear();
      await service.update(scope, { is_email_notifications_enabled: false }, undefined);
      expect(i18nLocaleCacheSpies.invalidate).not.toHaveBeenCalled();
    });
  });

  describe('userHasOrganizationRequiringMfa', () => {
    it('delegates to repository and returns boolean', async () => {
      vi.mocked(settingsRepository.userHasOrganizationRequiringMfa).mockResolvedValue(true);
      const result = await service.userHasOrganizationRequiringMfa(1);
      expect(result).toBe(true);
      expect(settingsRepository.userHasOrganizationRequiringMfa).toHaveBeenCalledWith(1);
    });

    it('returns false when no org requires MFA', async () => {
      const result = await service.userHasOrganizationRequiringMfa(1);
      expect(result).toBe(false);
    });
  });
});
