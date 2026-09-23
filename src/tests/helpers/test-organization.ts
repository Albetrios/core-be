import { database } from '@/infrastructure/database/connection.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import {
  createMembership,
  createRoleWithPermissions,
  seedPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { BILLING_PERMISSIONS } from '@/domains/billing/billing.permissions.js';
import { UPLOAD_PERMISSIONS } from '@/domains/upload/upload.permissions.js';
import { uploads } from '@/domains/upload/upload.schema.js';
import { getEnv } from '@/shared/config/env.config.js';

/**
 * Generate a test organization public ID for use in tests.
 * Legacy header helper — the X-Organization-Id header was removed; kept only where a suite deliberately sends an inert header.
 */
export function generateTestOrganizationId(): string {
  return generatePublicId('organization');
}

/**
 * Build standard organization headers for test requests.
 */
export function organizationHeaders(organizationId: string): Record<string, string> {
  return {
    'x-organization-id': organizationId,
  };
}

const DEFAULT_BILLING_PERMISSION_CODES = [
  BILLING_PERMISSIONS.SUBSCRIPTION_READ,
  BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE,
];

const DEFAULT_UPLOAD_PERMISSION_CODES = [UPLOAD_PERMISSIONS.UPLOAD_MANAGE];

export interface TwoOrganizationSubscriptionFixture {
  organizationA: { public_id: string; id: number };
  organizationB: { public_id: string; id: number };
  userA: { public_id: string; id: number; token: string };
  userB: { public_id: string; id: number; token: string };
  subscriptionInA: { public_id: string; id: number; status: string };
  subscriptionInB: { public_id: string; id: number; status: string };
  plan: { id: number; public_id: string };
}

/**
 * Seeds two organizations (A, B), two users (one owner per organization), billing subscriptions in each organization,
 * and grants subscription + upload permissions in the home organization only.
 */
export async function seedTwoOrganizationsWithSubscriptions(options?: {
  billingPermissionCodes?: string[];
  uploadPermissionCodes?: string[];
}): Promise<TwoOrganizationSubscriptionFixture> {
  const billingPermissionCodes =
    options?.billingPermissionCodes ?? DEFAULT_BILLING_PERMISSION_CODES;
  const uploadPermissionCodes = options?.uploadPermissionCodes ?? DEFAULT_UPLOAD_PERMISSION_CODES;

  await seedPermissions([...billingPermissionCodes, ...uploadPermissionCodes]);

  const userA = await createTestUser({
    email: `user-a-${generatePublicId('organization')}@cross-tenant.test`,
  });
  const userB = await createTestUser({
    email: `user-b-${generatePublicId('organization')}@cross-tenant.test`,
  });
  const organizationA = await createTestOrganization({ ownerUserId: userA.id });
  const organizationB = await createTestOrganization({ ownerUserId: userB.id });
  const plan = await createTestPlan();

  const roleA = await createRoleWithPermissions({
    organizationId: organizationA.id,
    permissionCodes: [...billingPermissionCodes, ...uploadPermissionCodes],
    createdByUserId: userA.id,
  });
  const roleB = await createRoleWithPermissions({
    organizationId: organizationB.id,
    permissionCodes: [...billingPermissionCodes, ...uploadPermissionCodes],
    createdByUserId: userB.id,
  });

  await createMembership({
    userId: userA.id,
    organizationId: organizationA.id,
    roleId: roleA.id,
  });
  await createMembership({
    userId: userB.id,
    organizationId: organizationB.id,
    roleId: roleB.id,
  });

  const subscriptionInA = await createTestSubscription({
    organizationId: organizationA.id,
    planId: plan.id,
    createdByUserId: userA.id,
  });
  const subscriptionInB = await createTestSubscription({
    organizationId: organizationB.id,
    planId: plan.id,
    createdByUserId: userB.id,
  });

  const tokenA = await generateTestToken({ userId: userA.public_id });
  const tokenB = await generateTestToken({ userId: userB.public_id });

  return {
    organizationA,
    organizationB,
    userA: { public_id: userA.public_id, id: userA.id, token: tokenA },
    userB: { public_id: userB.public_id, id: userB.id, token: tokenB },
    subscriptionInA,
    subscriptionInB,
    plan,
  };
}

export interface SeedUploadForOrganizationResult {
  public_id: string;
  id: number;
  user_id: number;
  organization_id: number | null;
  deleted_at: Date | null;
}

/**
 * Inserts an upload row owned by `userId`, optionally scoped to `organizationId` (internal id).
 */
export async function seedUploadForOrganization(options: {
  userId: number;
  organizationId?: number | null;
  createdByUserId?: number;
  status?: string;
}): Promise<SeedUploadForOrganizationResult> {
  const bucket = getEnv().S3_BUCKET ?? 'test-bucket';
  const publicId = generatePublicId('organization');
  const [row] = await database
    .insert(uploads)
    .values({
      public_id: publicId,
      user_id: options.userId,
      organization_id: options.organizationId ?? null,
      file_name: 'cross-tenant-fixture.png',
      file_key: `fixtures/${publicId}.png`,
      mime_type: 'image/png',
      file_size: 1024,
      storage_provider: 's3',
      bucket,
      status: options.status ?? 'UPLOADED',
      metadata: {},
      created_by_user_id: options.createdByUserId ?? options.userId,
    })
    .returning();

  return row!;
}
