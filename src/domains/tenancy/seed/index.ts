/**
 * Tenancy domain seed module — composes the permission sub-domain's reference contribution with
 * the organization/role/membership bulk graph and the per-organization sub-domain extras
 * (settings, notification policies, API keys, custom roles, pending invitations). Registered by
 * the bulk orchestrator.
 */
import { memberRolesSeedContribution } from '@/domains/tenancy/sub-domains/member-roles/seed/index.js';
import { memberInvitationSeedContribution } from '@/domains/tenancy/sub-domains/membership/member-invitation/seed/index.js';
import { organizationApiKeySeedContribution } from '@/domains/tenancy/sub-domains/organization/organization-api-key/seed/index.js';
import { organizationNotificationPolicySeedContribution } from '@/domains/tenancy/sub-domains/organization/organization-notification-policy/seed/index.js';
import { organizationSettingsSeedContribution } from '@/domains/tenancy/sub-domains/organization/organization-settings/seed/index.js';
import { permissionSeedContribution } from '@/domains/tenancy/sub-domains/permission/seed/index.js';
import {
  composeContributions,
  type DomainSeedModule,
  type SeedContribution,
} from '@/scripts/seed/seed-contract.js';
import { seedOrganizationsBulk } from './tenancy.bulk.seed.js';

const referenceContribution = composeContributions(permissionSeedContribution);

/**
 * Organization-pool contribution — seeds organizations, Admin roles, and memberships, and
 * populates `context.registry.organizations`. Must run before the per-organization sub-domain
 * extras, which read the registry.
 */
const organizationPoolContribution: SeedContribution = {
  seedBulk: seedOrganizationsBulk,
};

const bulkContribution = composeContributions(
  organizationPoolContribution,
  organizationSettingsSeedContribution,
  organizationNotificationPolicySeedContribution,
  organizationApiKeySeedContribution,
  memberRolesSeedContribution,
  memberInvitationSeedContribution,
);

/** The tenancy domain's seed module: permission reference data + organization/member/role bulk graph + extras. */
export const tenancySeedModule: DomainSeedModule = {
  name: 'tenancy',
  dependsOn: ['user'],
  seedReference: referenceContribution.seedReference,
  seedBulk: bulkContribution.seedBulk,
};
