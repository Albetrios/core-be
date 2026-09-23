import { describe, expect, it } from 'vitest';

import { BILLING_PERMISSIONS } from '@/domains/billing/billing.permissions.js';
import { NOTIFY_PERMISSIONS } from '@/domains/notify/notify.permissions.js';
import { ownerPermissionCodesForOrganizationType } from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';

/**
 * `ownerPermissionCodesForOrganizationType` is pure, so every property below is
 * checkable without a database — which is the point. The duplicate this first
 * test pins reached CI as a Postgres unique-violation on
 * `role_permissions (role_id, permission_code)`, because TEAM spread the whole
 * billing set on top of a base that already carried `subscription:read`.
 * Provisioning a TEAM organization died outright. A list this function returns
 * is inserted verbatim, so "no repeats" is a property of the function, not of
 * the schema.
 */
describe('ownerPermissionCodesForOrganizationType', () => {
  for (const type of ['TEAM', 'PERSONAL'] as const) {
    it(`returns no duplicate codes for ${type}`, () => {
      const codes = ownerPermissionCodesForOrganizationType(type);
      expect(codes).toHaveLength(new Set(codes).size);
    });
  }

  // Billing is an account-level surface, and every `subscription:read` route is
  // organization-scope `both` — so a personal owner must be able to reach it.
  it('grants the billing READ code to a personal owner', () => {
    expect(ownerPermissionCodesForOrganizationType('PERSONAL')).toContain(
      BILLING_PERMISSIONS.SUBSCRIPTION_READ,
    );
  });

  // The write half stays TEAM-only. `assertTeamOrganization` refuses it at the
  // service layer too, but withholding the code is the first of the two gates.
  it('withholds the billing MANAGE code from a personal owner', () => {
    expect(ownerPermissionCodesForOrganizationType('PERSONAL')).not.toContain(
      BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE,
    );
  });

  it('gives a team owner both billing codes', () => {
    const codes = ownerPermissionCodesForOrganizationType('TEAM');
    expect(codes).toContain(BILLING_PERMISSIONS.SUBSCRIPTION_READ);
    expect(codes).toContain(BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE);
  });

  // Webhooks remain a team surface; the frontend hides that half of Integrations
  // behind `webhook:read`, which a personal owner does not hold.
  it('withholds the notify codes from a personal owner', () => {
    const personal = ownerPermissionCodesForOrganizationType('PERSONAL');
    for (const code of Object.values(NOTIFY_PERMISSIONS)) {
      expect(personal).not.toContain(code);
    }
  });
});
