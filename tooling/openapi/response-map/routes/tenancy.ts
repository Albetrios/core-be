/** OpenAPI success responses — tenancy. */
import type { ResponseDefinition } from '@tooling/openapi/response-map/building-blocks.js';
import { wrapPaginated, wrapSuccess } from '@tooling/openapi/response-map/building-blocks.js';
import * as schemas from '@tooling/openapi/response-map/resource-schemas.js';

export const tenancyRouteResponses: Record<string, ResponseDefinition> = {
  // ── Organization ──
  'GET /api/v1/tenancy/organization': {
    statusCode: 200,
    schema: wrapSuccess(schemas.organizationSchema, schemas.organizationExample),
    example: null,
  },
  'GET /api/v1/tenancy/organizations/by-slug/{slug}': {
    statusCode: 200,
    schema: wrapSuccess(schemas.organizationSchema, schemas.organizationExample),
    example: null,
  },
  'POST /api/v1/tenancy/organizations': {
    statusCode: 200,
    schema: wrapSuccess(schemas.organizationSchema, schemas.organizationExample),
    example: null,
  },
  'PATCH /api/v1/tenancy/organization': {
    statusCode: 200,
    schema: wrapSuccess(schemas.organizationSchema, schemas.organizationExample),
    example: null,
  },
  'DELETE /api/v1/tenancy/organization': {
    statusCode: 204,
    schema: null,
    example: null,
  },
  'PUT /api/v1/tenancy/organization/logo': {
    statusCode: 200,
    schema: wrapSuccess(schemas.organizationSchema, schemas.organizationExample),
    example: null,
  },
  'DELETE /api/v1/tenancy/organization/logo': {
    statusCode: 204,
    schema: null,
    example: null,
  },

  // ── Organization: Settings ──
  'GET /api/v1/tenancy/organization/settings': {
    statusCode: 200,
    schema: wrapSuccess(schemas.organizationSettingsSchema, schemas.organizationSettingsExample),
    example: null,
  },
  'PATCH /api/v1/tenancy/organization/settings': {
    statusCode: 200,
    schema: wrapSuccess(schemas.organizationSettingsSchema, schemas.organizationSettingsExample),
    example: null,
  },

  // ── Organization: API Keys ──
  'GET /api/v1/tenancy/organization/api-keys': {
    statusCode: 200,
    schema: wrapPaginated(schemas.apiKeySchema, [schemas.apiKeyExample]),
    example: null,
  },
  'GET /api/v1/tenancy/organization/api-keys/{api_key_id}': {
    statusCode: 200,
    schema: wrapSuccess(schemas.apiKeySchema, schemas.apiKeyExample),
    example: null,
  },
  'POST /api/v1/tenancy/organization/api-keys': {
    statusCode: 200,
    schema: wrapSuccess(
      {
        ...schemas.apiKeySchema,
        properties: { ...schemas.apiKeySchema.properties, key: { type: 'string' } },
      },
      schemas.apiKeyCreatedExample,
    ),
    example: null,
  },
  'PATCH /api/v1/tenancy/organization/api-keys/{api_key_id}': {
    statusCode: 200,
    schema: wrapSuccess(schemas.apiKeySchema, schemas.apiKeyExample),
    example: null,
  },
  'DELETE /api/v1/tenancy/organization/api-keys/{api_key_id}': {
    statusCode: 204,
    schema: null,
    example: null,
  },
  'POST /api/v1/tenancy/organization/api-keys/{api_key_id}/rotate': {
    statusCode: 200,
    schema: wrapSuccess(
      {
        ...schemas.apiKeySchema,
        properties: { ...schemas.apiKeySchema.properties, key: { type: 'string' } },
      },
      schemas.apiKeyCreatedExample,
    ),
    example: null,
  },

  // ── Organization: Notification Policies ──
  'GET /api/v1/tenancy/organization/notification-policies': {
    statusCode: 200,
    schema: wrapSuccess({ type: 'array', items: schemas.notificationPolicySchema }, [
      schemas.notificationPolicyExample,
    ]),
    example: null,
  },
  'GET /api/v1/tenancy/organization/notification-policies/{notification_policy_id}': {
    statusCode: 200,
    schema: wrapSuccess(schemas.notificationPolicySchema, schemas.notificationPolicyExample),
    example: null,
  },
  'POST /api/v1/tenancy/organization/notification-policies': {
    statusCode: 200,
    schema: wrapSuccess(schemas.notificationPolicySchema, schemas.notificationPolicyExample),
    example: null,
  },
  'PATCH /api/v1/tenancy/organization/notification-policies/{notification_policy_id}': {
    statusCode: 200,
    schema: wrapSuccess(schemas.notificationPolicySchema, schemas.notificationPolicyExample),
    example: null,
  },
  'DELETE /api/v1/tenancy/organization/notification-policies/{notification_policy_id}': {
    statusCode: 204,
    schema: null,
    example: null,
  },

  // ── Organization: Audit Logs ──
  'GET /api/v1/tenancy/organization/audit-logs': {
    statusCode: 200,
    schema: wrapPaginated(schemas.auditLogSchema, [schemas.auditLogExample]),
    example: null,
  },

  // ── Membership ──
  'GET /api/v1/tenancy/organization/memberships': {
    statusCode: 200,
    schema: wrapPaginated(schemas.membershipSchema, [schemas.membershipExample]),
    example: null,
  },
  'GET /api/v1/tenancy/organization/memberships/{membership_id}': {
    statusCode: 200,
    schema: wrapSuccess(schemas.membershipSchema, schemas.membershipExample),
    example: null,
  },
  'GET /api/v1/tenancy/organization/memberships/{membership_id}/permissions': {
    statusCode: 200,
    schema: wrapSuccess({ type: 'array', items: schemas.permissionSchema }, [
      schemas.permissionExample,
    ]),
    example: null,
  },
  'POST /api/v1/tenancy/organization/memberships': {
    statusCode: 200,
    schema: wrapSuccess(schemas.membershipSchema, schemas.membershipExample),
    example: null,
  },
  'PATCH /api/v1/tenancy/organization/memberships/{membership_id}': {
    statusCode: 200,
    schema: wrapSuccess(schemas.membershipSchema, schemas.membershipExample),
    example: null,
  },
  'DELETE /api/v1/tenancy/organization/memberships/{membership_id}': {
    statusCode: 204,
    schema: null,
    example: null,
  },
  'POST /api/v1/tenancy/organization/leave': {
    statusCode: 200,
    schema: null,
    example: null,
  },
  'POST /api/v1/tenancy/organization/transfer-ownership': {
    statusCode: 200,
    schema: wrapSuccess(schemas.membershipSchema, schemas.membershipExample),
    example: null,
  },

  // ── Invitations ── (add-member issues invitations via POST /organization/memberships, REQ-1)
  'POST /api/v1/tenancy/invitations/{invitation_id}/accept': {
    // Returns the accepted invitation plus `organization_id` (the organization just joined) so the client
    // can POST /auth/switch-to-organization into it without a separate lookup.
    statusCode: 200,
    schema: wrapSuccess(
      {
        type: 'object',
        properties: {
          ...schemas.invitationSchema.properties,
          organization_id: {
            type: 'string',
            description:
              'Public id of the joined organization — pass to POST /auth/switch-to-organization.',
          },
        },
      },
      {
        ...schemas.invitationExample,
        accepted_at: '2026-02-14T11:00:00.000Z',
        organization_id: 'org_k7x9m2pqr4w8n1v3a1b2c',
      },
    ),
    example: null,
  },
  'DELETE /api/v1/tenancy/organization/invitations/{invitation_id}': {
    statusCode: 204,
    schema: null,
    example: null,
  },
  'POST /api/v1/tenancy/organization/invitations/{invitation_id}/resend': {
    statusCode: 200,
    schema: wrapSuccess(schemas.invitationSchema, {
      ...schemas.invitationExample,
      expires_at: '2026-02-28T10:30:00.000Z',
    }),
    example: null,
  },

  // ── Roles ──
  'GET /api/v1/tenancy/organization/roles': {
    statusCode: 200,
    schema: wrapPaginated(schemas.memberRoleSchema, [schemas.memberRoleExample]),
    example: null,
  },
  'GET /api/v1/tenancy/organization/roles/{role_id}': {
    statusCode: 200,
    schema: wrapSuccess(schemas.memberRoleSchema, schemas.memberRoleExample),
    example: null,
  },
  'POST /api/v1/tenancy/organization/roles': {
    statusCode: 200,
    schema: wrapSuccess(schemas.memberRoleSchema, {
      ...schemas.memberRoleExample,
      name: 'Editor',
      description: 'Can edit content',
      is_system: false,
    }),
    example: null,
  },
  'PATCH /api/v1/tenancy/organization/roles/{role_id}': {
    statusCode: 200,
    schema: wrapSuccess(schemas.memberRoleSchema, schemas.memberRoleExample),
    example: null,
  },
  'DELETE /api/v1/tenancy/organization/roles/{role_id}': {
    statusCode: 204,
    schema: null,
    example: null,
  },

  // ── Role Permissions ──
  'GET /api/v1/tenancy/organization/roles/{role_id}/permissions': {
    statusCode: 200,
    schema: wrapSuccess(
      { type: 'array', items: schemas.memberRolePermissionSchema },
      schemas.memberRolePermissionExamples,
    ),
    example: null,
  },
  'PUT /api/v1/tenancy/organization/roles/{role_id}/permissions': {
    statusCode: 200,
    schema: wrapSuccess(
      { type: 'array', items: schemas.memberRolePermissionSchema },
      schemas.memberRolePermissionExamples,
    ),
    example: null,
  },

  // ── Permissions ──
  'GET /api/v1/tenancy/permissions': {
    statusCode: 200,
    schema: wrapSuccess({ type: 'array', items: schemas.permissionSchema }, [
      schemas.permissionExample,
      {
        code: 'MEMBERSHIP_READ',
        name: 'Read Memberships',
        description: 'View organization members',
        category: 'membership',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        code: 'ROLE_READ',
        name: 'Read Roles',
        description: 'View organization roles',
        category: 'role',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]),
    example: null,
  },

  // ── Plans ──
};
