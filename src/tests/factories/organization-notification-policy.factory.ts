import { database } from '@/infrastructure/database/connection.js';
import { organization_notification_policies } from '@/domains/tenancy/sub-domains/organization/organization-notification-policy/organization-notification-policy.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

export interface CreateNotificationPolicyOptions {
  organizationId: number;
  notificationType?: string;
  channel?: string;
  defaultEnabled?: boolean;
  isMandatory?: boolean;
  createdByUserId?: number;
}

/**
 * Create a test notification policy for `organizationId` (tenancy.organization_notification_policies).
 */
export async function createTestNotificationPolicy(options: CreateNotificationPolicyOptions) {
  const publicId = generatePublicId('organizationNotificationPolicy');
  const [policy] = await database
    .insert(organization_notification_policies)
    .values({
      public_id: publicId,
      organization_id: options.organizationId,
      notification_type: options.notificationType ?? 'billing',
      channel: options.channel ?? 'EMAIL',
      default_enabled: options.defaultEnabled ?? true,
      is_mandatory: options.isMandatory ?? false,
      created_by_user_id: options.createdByUserId,
    })
    .returning();
  return policy!;
}
