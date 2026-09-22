/** Tenancy resource schemas. */
// ── Organization ──
export const organizationSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    // Kept non-nullable to match the published contract; a personal org's null
    // slug is discoverable from `type === 'PERSONAL'`. Flipping this to nullable is a breaking
    // response change and out of scope here.
    slug: { type: 'string' },
    type: {
      type: 'string',
      enum: ['PERSONAL', 'TEAM'],
      description: 'Possible values: PERSONAL | TEAM',
      example: 'TEAM',
    },
    status: {
      type: 'string',
      enum: ['ACTIVE', 'SUSPENDED', 'ARCHIVED'],
      description: 'Possible values: ACTIVE | SUSPENDED | ARCHIVED',
      example: 'ACTIVE',
    },
    logo_url: { type: 'string', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

export const organizationExample = {
  id: 'org_k7x9m2pqr4w8n1v3a1b2c',
  name: 'Acme Corporation',
  slug: 'acme-corporation',
  type: 'TEAM',
  status: 'ACTIVE',
  logo_url: 'https://cdn.example.com/logos/acme-corp.png',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-02-10T12:00:00.000Z',
};

// ── Organization Settings ──
export const organizationSettingsSchema = {
  type: 'object',
  properties: {
    organization_id: { type: 'string' },
    is_email_notifications_enabled: { type: 'boolean' },
    security_policy: { type: 'object' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

export const organizationSettingsExample = {
  organization_id: 'org_k7x9m2pqr4w8n1v3a1b2c',
  is_email_notifications_enabled: true,
  security_policy: { mfa_required: true, session_timeout_minutes: 30 },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-02-10T12:00:00.000Z',
};

// ── Organization API Key ──
export const apiKeySchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    organization_id: { type: 'string' },
    name: { type: 'string' },
    key_prefix: { type: 'string' },
    last_used_at: { type: 'string', format: 'date-time', nullable: true },
    expires_at: { type: 'string', format: 'date-time', nullable: true },
    status: {
      type: 'string',
      enum: ['ACTIVE', 'REVOKED'],
      description: 'Possible values: ACTIVE | REVOKED',
      example: 'ACTIVE',
    },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

// API key example for the OpenAPI response-map. These values surface in
// generated docs (Swagger / Redoc / Postman). Do NOT use Stripe-shaped
// prefixes (`sk_live_`, `sk_test_`, `whsec_`) here — GitHub Secret Scanning
// matches those patterns by raw regex against committed source and cannot
// distinguish a documentation placeholder from a leaked production secret.
// Use a clearly-fake redacted shape so future regenerations stay scanner-safe.
export const apiKeyExample = {
  id: 'key_x9k3m7n2p5q8w1r4a1b2c',
  organization_id: 'org_k7x9m2pqr4w8n1v3a1b2c',
  name: 'Production API Key',
  key_prefix: 'ak_redacted',
  last_used_at: '2026-02-14T07:45:00.000Z',
  expires_at: '2027-02-14T00:00:00.000Z',
  status: 'ACTIVE',
  created_at: '2026-01-15T10:30:00.000Z',
  updated_at: '2026-02-10T14:20:00.000Z',
};

export const apiKeyCreatedExample = {
  ...apiKeyExample,
  key: '<api-key-shown-once>',
};

// ── Organization Notification Policy ──
export const notificationPolicySchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    organization_id: { type: 'string' },
    notification_type: { type: 'string' },
    channel: {
      type: 'string',
      enum: ['EMAIL', 'SMS', 'PUSH', 'IN_APP'],
      description: 'Possible values: EMAIL | SMS | PUSH | IN_APP',
      example: 'EMAIL',
    },
    default_enabled: { type: 'boolean' },
    is_mandatory: { type: 'boolean' },
    muted_until: { type: 'string', format: 'date-time', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

export const notificationPolicyExample = {
  id: 1,
  organization_id: 'org_k7x9m2pqr4w8n1v3a1b2c',
  notification_type: 'subscription.updated',
  channel: 'email',
  default_enabled: true,
  is_mandatory: false,
  muted_until: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-02-10T12:00:00.000Z',
};

// ── Membership ──
export const membershipSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    user_id: { type: 'string' },
    organization_id: { type: 'string' },
    role_id: { type: 'string' },
    status: {
      type: 'string',
      enum: ['INVITED', 'ACTIVE', 'SUSPENDED'],
      description: 'Possible values: INVITED | ACTIVE | SUSPENDED',
      example: 'INVITED',
    },
    joined_at: { type: 'string', format: 'date-time', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    // Embedded display summary so a members table renders without an N+1 per-row user fetch.
    user: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        email: { type: 'string', format: 'email' },
        first_name: { type: 'string', nullable: true },
        last_name: { type: 'string', nullable: true },
        avatar_url: {
          type: 'string',
          nullable: true,
          description: 'Presigned read URL (or absolute provider URL); never a raw object key.',
        },
      },
    },
    role: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
      },
    },
    // Live (pending) invitation reference — present only on INVITED rows so the frontend can
    // Resend/Revoke from the members table; null for ACTIVE/SUSPENDED rows.
    invitation: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'string' },
        expires_at: { type: 'string', format: 'date-time' },
      },
    },
  },
};

export const membershipExample = {
  id: 'mbr_q8w3n7p2m5k1r4t6',
  user_id: 'usr_k7x9m2pqr4w8n1v3a1b2c',
  organization_id: 'org_k7x9m2pqr4w8n1v3a1b2c',
  role_id: 'rol_m3n7p2q8w5k1r4t6a1b2c',
  status: 'ACTIVE',
  joined_at: '2026-01-15T10:30:00.000Z',
  created_at: '2026-01-15T10:30:00.000Z',
  updated_at: '2026-02-10T14:20:00.000Z',
  user: {
    id: 'usr_k7x9m2pqr4w8n1v3a1b2c',
    email: 'john.doe@example.com',
    first_name: 'John',
    last_name: 'Doe',
    avatar_url: 'https://cdn.example.com/avatars/john-doe.jpg',
  },
  role: {
    id: 'rol_m3n7p2q8w5k1r4t6a1b2c',
    name: 'Admin',
  },
  invitation: null,
};

// ── Member Invitation ──
export const invitationSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    membership_id: { type: 'string' },
    email: { type: 'string', format: 'email' },
    expires_at: { type: 'string', format: 'date-time' },
    accepted_at: { type: 'string', format: 'date-time', nullable: true },
    revoked_at: { type: 'string', format: 'date-time', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
  },
};

export const invitationExample = {
  id: 'inv_r4t6m3n7p2q8w5k1a1b2c',
  membership_id: 'mbr_q8w3n7p2m5k1r4t6',
  email: 'jane.smith@example.com',
  expires_at: '2026-02-21T10:30:00.000Z',
  accepted_at: null,
  revoked_at: null,
  created_at: '2026-02-14T10:30:00.000Z',
};

// ── Member Role ──
export const memberRoleSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string', nullable: true },
    is_system: { type: 'boolean' },
    member_count: {
      type: 'integer',
      minimum: 0,
      description: 'Members (ACTIVE or INVITED) assigned this role in the organization.',
      example: 3,
    },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

export const memberRoleExample = {
  id: 'rol_m3n7p2q8w5k1r4t6a1b2c',
  name: 'Admin',
  description: 'Full access to all organization resources',
  is_system: true,
  member_count: 3,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

// ── Member Role Permission ──
export const memberRolePermissionSchema = {
  type: 'object',
  properties: {
    role_id: { type: 'string' },
    permission_code: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
  },
};

export const memberRolePermissionExamples = [
  {
    role_id: 'rol_m3n7p2q8w5k1r4t6a1b2c',
    permission_code: 'ORGANIZATION_READ',
    created_at: '2026-01-01T00:00:00.000Z',
  },
  {
    role_id: 'rol_m3n7p2q8w5k1r4t6a1b2c',
    permission_code: 'MEMBERSHIP_READ',
    created_at: '2026-01-01T00:00:00.000Z',
  },
  {
    role_id: 'rol_m3n7p2q8w5k1r4t6a1b2c',
    permission_code: 'ROLE_READ',
    created_at: '2026-01-01T00:00:00.000Z',
  },
];

// ── Permission ──
export const permissionSchema = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string', nullable: true },
    category: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
  },
};

export const permissionExample = {
  code: 'organization:read',
  name: 'View Organization',
  description: null,
  category: 'tenancy',
  created_at: '2026-01-01T00:00:00.000Z',
};
