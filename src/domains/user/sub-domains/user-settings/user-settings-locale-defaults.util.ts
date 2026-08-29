import type { OrganizationSettingsOutput } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.types.js';

type OrganizationDefaultLocale = OrganizationSettingsOutput['default_locale'];

/** Out-of-the-box default language tag for new users (used until the row is materialized or overridden). */
export const FACTORY_DEFAULT_USER_LANGUAGE = 'en';

/** Out-of-the-box `preferred_locales` list — must mirror the JSONB default in the schema. */
export const FACTORY_DEFAULT_USER_PREFERRED_LOCALES = [FACTORY_DEFAULT_USER_LANGUAGE] as const;

type UserLocaleSettingsRow = {
  language: string;
  preferred_locales: unknown;
};

/**
 * Returns `true` when the user has never customised their locale settings — i.e. the row is
 * missing or still equals the factory defaults. Callers (e.g. organization-default-locale flows)
 * use this to know whether they may overwrite the row without clobbering an explicit user choice.
 */
export function isFactoryDefaultUserLocaleSettings(
  settings: UserLocaleSettingsRow | null | undefined,
): boolean {
  if (!settings) {
    return true;
  }
  const preferredLocales = settings.preferred_locales as string[];
  return (
    settings.language === FACTORY_DEFAULT_USER_LANGUAGE &&
    preferredLocales.length === 1 &&
    preferredLocales[0] === FACTORY_DEFAULT_USER_LANGUAGE
  );
}

/**
 * Build the `preferred_locales` array that should be applied when adopting the organization's
 * default locale for a user without explicit locale preferences. Currently a single-element list
 * but kept as a helper so future fallback chains (e.g. `[organization, 'en']`) can be added in one place.
 */
export function preferredLocalesForOrganizationDefaultLocale(
  organizationDefaultLocale: OrganizationDefaultLocale,
): string[] {
  return [organizationDefaultLocale];
}
