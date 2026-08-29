import { eq, sql } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import { databaseNowTimestamp } from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { organization_settings } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.schema.js';

/** BCP 47 locale tag persisted in `organization_settings.default_locale` (constrained to translated locales). */
export type OrganizationDefaultLocale = 'en' | 'es';

/**
 * Drizzle data-access for `tenancy.organization_settings`. The `upsert`
 * primary path is keyed on `organization_id` (1:1 with the organization row). Two
 * helpers (`findDefaultLocaleByOrganizationPublicId`,
 * `userHasOrganizationRequiringMfa`) run during the authentication /
 * middleware phase, before any tenant GUC exists; because the underlying
 * tables are FORCE RLS, they delegate to `SECURITY DEFINER` resolvers
 * (`tenancy.resolve_organization_default_locale`,
 * `tenancy.user_has_organization_requiring_mfa`) which bypass RLS by
 * ownership — a plain SELECT under the non-superuser app role would match
 * zero rows and silently disable organization-mandated MFA.
 */
export class OrganizationSettingsRepository {
  /**
   * Login-time / middleware locale (no tenant HTTP context): resolve organization default BCP 47 tag.
   */
  async findDefaultLocaleByOrganizationPublicId(
    organizationPublicId: string,
  ): Promise<OrganizationDefaultLocale | null> {
    // `tenancy.organization_settings`/`organizations` are FORCE RLS and this runs with no
    // tenant GUC (login/middleware), so a plain SELECT under the non-superuser app role would
    // return 0 rows. Delegate to the SECURITY DEFINER resolver (RLS bypass by ownership).
    const rows = await database.execute(
      sql`SELECT tenancy.resolve_organization_default_locale(${organizationPublicId}) AS default_locale`,
    );
    const resultRows = (
      Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
    ) as { default_locale: string | null }[];
    const locale = resultRows[0]?.default_locale ?? null;
    if (!locale) {
      return null;
    }
    return locale === 'es' ? 'es' : 'en';
  }

  async findByOrganizationId(organization_id: number) {
    const rows = await getRequestDatabase()
      .select()
      .from(organization_settings)
      .where(eq(organization_settings.organization_id, organization_id))
      .limit(1);
    return rows[0] ?? null;
  }

  async upsert(
    organization_id: number,
    data: {
      is_email_notifications_enabled?: boolean;
      default_locale?: OrganizationDefaultLocale;
      security_policy?: object;
      updated_by_user_id?: number | null;
    },
  ) {
    const row = {
      organization_id,
      is_email_notifications_enabled: data.is_email_notifications_enabled ?? true,
      default_locale: data.default_locale ?? 'en',
      security_policy: data.security_policy ?? {},
      updated_by_user_id: data.updated_by_user_id ?? undefined,
    };
    const rows = await getRequestDatabase()
      .insert(organization_settings)
      .values(row)
      .onConflictDoUpdate({
        target: organization_settings.organization_id,
        set: {
          ...(data.is_email_notifications_enabled !== undefined && {
            is_email_notifications_enabled: data.is_email_notifications_enabled,
          }),
          // audit #11: MERGE the incoming security_policy keys into the existing JSONB instead of a
          // whole-object replace. A wholesale replace made two concurrent PATCHes last-writer-wins,
          // so one admin enabling organization-mandated MFA could be silently reverted by another admin
          // editing an unrelated key. `||` composes: incoming keys win on overlap, untouched keys
          // are preserved. To remove a key, set it explicitly (e.g. `{mfa_required: false}`).
          ...(data.security_policy !== undefined && {
            security_policy: sql`coalesce(${organization_settings.security_policy}, '{}'::jsonb) || excluded.security_policy`,
          }),
          ...(data.default_locale !== undefined && { default_locale: data.default_locale }),
          updated_at: databaseNowTimestamp,
          updated_by_user_id: data.updated_by_user_id ?? undefined,
        },
      })
      .returning();
    return rows[0]!;
  }

  /**
   * Login-time check (no tenant HTTP context): true when the user belongs to an active
   * membership in an organization whose security_policy requires MFA.
   */
  async userHasOrganizationRequiringMfa(userId: number): Promise<boolean> {
    // `tenancy.memberships`/`organization_settings` are FORCE RLS and this runs at login with
    // no tenant/user GUC, so a plain JOIN under the non-superuser app role would return 0 rows
    // and silently disable organization-mandated MFA in production. Delegate to the SECURITY DEFINER
    // resolver (RLS bypass by ownership), which encodes the strict `mfa_required === true` check.
    const rows = await database.execute(
      sql`SELECT tenancy.user_has_organization_requiring_mfa(${userId}) AS requires_mfa`,
    );
    const resultRows = (
      Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
    ) as { requires_mfa: boolean | null }[];
    return resultRows[0]?.requires_mfa === true;
  }
}
