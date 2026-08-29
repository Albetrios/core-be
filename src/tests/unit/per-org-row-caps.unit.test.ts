import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * sec-r5-followup-ratelimit-dos-1/2/3 regression — every per-organization row that the
 * API can create at a tenant's pace (API keys, custom roles, notification
 * policies) MUST be capped by a `*_MAX_PER_ORG` env-driven count. Mirrors the
 * existing `WEBHOOK_MAX_PER_ORG` invariant on `webhook.service.create` (sec-N4).
 *
 * Asserts at the source-text level rather than via full-stack mocks because
 * each service has substantial dependency wiring; the textual check is enough
 * to prevent a silent refactor from removing the cap (the same pattern used
 * by `member-role-permission.repository.bound.policy.unit.test.ts` and the
 * `*-routes-rate-limit.policy.unit.test.ts` files).
 */
describe('per-organization row caps (sec-r5-followup-ratelimit-dos-1/2/3)', () => {
  function readService(...relativePathSegments: string[]): string {
    return readFileSync(join(process.cwd(), ...relativePathSegments), 'utf8');
  }

  describe('OrganizationApiKeyService.create — ORGANIZATION_API_KEY_MAX_PER_ORG', () => {
    const source = readService(
      'src/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.service.ts',
    );

    it('reads `env.ORGANIZATION_API_KEY_MAX_PER_ORG`', () => {
      expect(source).toMatch(/env\.ORGANIZATION_API_KEY_MAX_PER_ORG/);
    });

    it('calls `apiKeyRepository.countActiveByOrganization` and compares with `>=`', () => {
      expect(source).toMatch(/apiKeyRepository\.countActiveByOrganization/);
      expect(source).toMatch(/>=\s*env\.ORGANIZATION_API_KEY_MAX_PER_ORG/);
    });

    it('throws `ConflictError` with the matching i18n key when the cap is reached', () => {
      expect(source).toMatch(
        /throw\s+new\s+ConflictError\(['"]errors:organizationApiKeyMaxReached['"]/,
      );
    });
  });

  describe('MemberRoleService.create — MEMBER_ROLE_MAX_PER_ORG', () => {
    const source = readService(
      'src/domains/tenancy/sub-domains/member-roles/member-role.service.ts',
    );

    it('reads `env.MEMBER_ROLE_MAX_PER_ORG`', () => {
      expect(source).toMatch(/env\.MEMBER_ROLE_MAX_PER_ORG/);
    });

    it('calls `memberRoleRepository.countActiveByOrganization` and compares with `>=`', () => {
      expect(source).toMatch(/memberRoleRepository\.countActiveByOrganization/);
      expect(source).toMatch(/>=\s*env\.MEMBER_ROLE_MAX_PER_ORG/);
    });

    it('throws `ConflictError` with the matching i18n key when the cap is reached', () => {
      expect(source).toMatch(/throw\s+new\s+ConflictError\(['"]errors:memberRoleMaxReached['"]/);
    });
  });

  describe('MembershipService.assertSeatAvailableForMemberAdd — MEMBERSHIP_SEAT advisory lock (audit-#M1)', () => {
    const source = readService('src/domains/tenancy/sub-domains/membership/membership.service.ts');

    it('acquires the MEMBERSHIP_SEAT advisory lock so the free-tier count+insert is serialized', () => {
      expect(source).toMatch(
        /acquireResourceQuotaLock\(\s*RESOURCE_QUOTA_LOCK_NAMESPACE\.MEMBERSHIP_SEAT/,
      );
    });

    it('takes the lock BEFORE reading the seat ceiling (serializes the whole check+insert)', () => {
      const lockIndex = source.indexOf('RESOURCE_QUOTA_LOCK_NAMESPACE.MEMBERSHIP_SEAT');
      const ceilingIndex = source.indexOf('reserveSeatCeilingForMemberAdd(organizationInternalId)');
      expect(lockIndex).toBeGreaterThan(0);
      expect(ceilingIndex).toBeGreaterThan(lockIndex);
    });

    it('compares used seats with `>=` the ceiling', () => {
      expect(source).toMatch(/seatsUsed\s*>=\s*seatCeiling/);
    });
  });

  describe('OrganizationNotificationPolicyService.create — ORGANIZATION_NOTIFICATION_POLICY_MAX_PER_ORG', () => {
    const source = readService(
      'src/domains/tenancy/sub-domains/organization/organization-notification-policy/organization-notification-policy.service.ts',
    );

    it('reads `env.ORGANIZATION_NOTIFICATION_POLICY_MAX_PER_ORG`', () => {
      expect(source).toMatch(/env\.ORGANIZATION_NOTIFICATION_POLICY_MAX_PER_ORG/);
    });

    it('calls `policyRepository.countActiveByOrganization` and compares with `>=`', () => {
      expect(source).toMatch(/policyRepository\.countActiveByOrganization/);
      expect(source).toMatch(/>=\s*env\.ORGANIZATION_NOTIFICATION_POLICY_MAX_PER_ORG/);
    });

    it('throws `ConflictError` with the matching i18n key when the cap is reached', () => {
      expect(source).toMatch(
        /throw\s+new\s+ConflictError\(['"]errors:organizationNotificationPolicyMaxReached['"]/,
      );
    });

    it('list-helper applies `.limit(env.ORGANIZATION_NOTIFICATION_POLICY_MAX_PER_ORG)` (defense-in-depth)', () => {
      const repositorySource = readService(
        'src/domains/tenancy/sub-domains/organization/organization-notification-policy/organization-notification-policy.repository.ts',
      );
      expect(repositorySource).toMatch(
        /\.limit\(env\.ORGANIZATION_NOTIFICATION_POLICY_MAX_PER_ORG\)/,
      );
    });
  });
});
