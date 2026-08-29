import { NotFoundError } from '@/shared/errors/index.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationRepository } from '@/domains/tenancy/sub-domains/organization/organization.repository.js';
import type { OrganizationSettingsRepository } from './organization-settings.repository.js';
import type {
  OrganizationDefaultLocale,
  OrganizationSettingsOutput,
} from './organization-settings.types.js';
import { validateUpdateOrganizationSettings } from './organization-settings.validator.js';
import { serializeOrganizationSettings } from './organization-settings.serializer.js';
import {
  getCachedOrganizationDefaultLocale,
  invalidateCachedOrganizationDefaultLocale,
  setCachedOrganizationDefaultLocale,
} from './i18n-locale.cache.js';

/**
 * Read/write service for the per-organization settings row plus two
 * unscoped helpers used during authentication.
 *
 * @remarks
 * - **Algorithm:** `get` and `update` take the token-minted
 *   {@link OrganizationPrincipalDatabaseScope} from the controller and run inside
 *   `withAppDatabaseContext` (RLS) — they lazily upsert the row when
 *   missing; `update` strips undefined fields with `omitUndefined` so PATCH
 *   semantics preserve unchanged columns.
 *   `resolveDefaultLocaleForOrganization` falls back to `'en'` when nothing
 *   is configured. `userHasOrganizationRequiringMfa` is delegated to the
 *   repository's unscoped query (no tenant context yet at login time).
 * - **Failure modes:** `NotFoundError('Organization')` when the parent
 *   organization is missing or invisible under RLS; validation errors
 *   propagate from {@link validateUpdateOrganizationSettings}.
 * - **Side effects:** `upsert` writes to `tenancy.organization_settings`;
 *   no events are emitted and no external I/O is performed.
 * - **Notes:** the locale and MFA helpers intentionally bypass tenant RLS
 *   because they run during login flow before the tenant cookie/header is
 *   resolved.
 */
export class OrganizationSettingsService {
  constructor(
    private readonly organizationRepository: OrganizationRepository,
    private readonly settingsRepository: OrganizationSettingsRepository,
  ) {}

  async get(scope: OrganizationPrincipalDatabaseScope): Promise<OrganizationSettingsOutput> {
    return withAppDatabaseContext(scope, async () => {
      const organization = await this.organizationRepository.findByPublicId(
        scope.organizationPublicId,
      );
      if (!organization) throw new NotFoundError('Organization');
      const settings = await this.settingsRepository.findByOrganizationId(organization.id);
      if (!settings) {
        const created = await this.settingsRepository.upsert(organization.id, {});
        return serializeOrganizationSettings(organization.public_id, created);
      }
      return serializeOrganizationSettings(organization.public_id, settings);
    });
  }

  async update(
    scope: OrganizationPrincipalDatabaseScope,
    body: unknown,
    _updated_by_user_public_id: string | undefined,
  ): Promise<OrganizationSettingsOutput> {
    const parsed = validateUpdateOrganizationSettings(body);
    const result = await withAppDatabaseContext(scope, async () => {
      const organization = await this.organizationRepository.findByPublicId(
        scope.organizationPublicId,
      );
      if (!organization) throw new NotFoundError('Organization');
      const updated = await this.settingsRepository.upsert(
        organization.id,
        omitUndefined({
          is_email_notifications_enabled: parsed.is_email_notifications_enabled,
          default_locale: parsed.default_locale,
          security_policy: parsed.security_policy as object | undefined,
        }),
      );
      return serializeOrganizationSettings(organization.public_id, updated);
    });
    // sec-M1: drop the i18n locale cache for the organization so a dashboard switch
    // is reflected in the next request rather than waiting for the TTL.
    // Outside the DB context (cache write must not roll back with the organization tx).
    if (parsed.default_locale !== undefined) {
      await invalidateCachedOrganizationDefaultLocale(scope.organizationPublicId);
    }
    return result;
  }

  async resolveDefaultLocaleForOrganization(
    organizationPublicId: string,
  ): Promise<OrganizationDefaultLocale> {
    /**
     * sec-M1: Redis cache short-circuits the SECURITY DEFINER DB call on every
     * pre-auth i18n preHandler hit. Without it, every unauthenticated request
     * that supplies an `X-Organization-Id` header without `Accept-Language`
     * triggers a DB round-trip — distributed attackers can drive thousands of
     * pre-auth lookups per second and use the differential response language
     * as an organization-existence oracle. The cache stores the canonical
     * `'en'` fallback too, so unknown ids stop hitting the DB after the first
     * lookup. Mutations to `default_locale` (via `update`) invalidate the
     * cache so a dashboard change is visible on the next request.
     */
    const cached = await getCachedOrganizationDefaultLocale(organizationPublicId);
    if (cached !== null) {
      return cached as OrganizationDefaultLocale;
    }
    const locale = await withAppDatabaseContext(
      PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organizationPublicId }),
      async () => {
        const found =
          await this.settingsRepository.findDefaultLocaleByOrganizationPublicId(
            organizationPublicId,
          );
        return found ?? 'en';
      },
    );
    await setCachedOrganizationDefaultLocale(organizationPublicId, locale);
    return locale;
  }

  async userHasOrganizationRequiringMfa(userId: number): Promise<boolean> {
    return this.settingsRepository.userHasOrganizationRequiringMfa(userId);
  }
}
