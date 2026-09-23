/** Notify, audit, and upload resource schemas. */
// ── Notification ──
export const notificationSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    user_id: { type: 'string' },
    type: { type: 'string' },
    title: { type: 'string' },
    body: { type: 'string' },
    is_read: { type: 'boolean' },
    read_at: { type: 'string', format: 'date-time', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
  },
};

export const notificationExample = {
  id: 'ntf_m7n2p5q8w1r4x9k3a1b2c',
  user_id: 'usr_k7x9m2pqr4w8n1v3a1b2c',
  type: 'subscription.updated',
  title: 'Subscription updated',
  body: 'Your subscription was updated successfully.',
  is_read: false,
  read_at: null,
  created_at: '2026-02-14T10:00:00.000Z',
};

// ── Unread Count ──
export const unreadCountSchema = {
  type: 'object',
  properties: {
    unread_count: { type: 'integer' },
  },
};

// ── Webhook ──
export const webhookSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    organization_id: { type: 'string' },
    url: { type: 'string', format: 'uri' },
    events: { type: 'array', items: { type: 'string' } },
    is_enabled: { type: 'boolean' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

export const webhookExample = {
  id: 'whk_p5q8w1r4x9k3m7n2a1b2c',
  organization_id: 'org_k7x9m2pqr4w8n1v3a1b2c',
  url: 'https://api.example.com/webhooks/receive',
  events: ['subscription.created', 'subscription.updated', 'member.invited'],
  is_enabled: true,
  created_at: '2026-01-20T09:00:00.000Z',
  updated_at: '2026-02-10T14:20:00.000Z',
};

// ── Webhook Event ──
export const webhookEventSchema = {
  type: 'object',
  properties: {
    event: { type: 'string' },
    description: { type: 'string' },
  },
};

// Verbatim entries from AVAILABLE_WEBHOOK_EVENTS (webhook-event.repository.ts). The former
// third example, `member.invited`, is not dispatchable — no such event type exists, and the
// membership events are `membership.created` / `.updated` / `.deleted`.
export const webhookEventExamples = [
  { event: 'organization.created', description: 'When an organization is created' },
  { event: 'membership.created', description: 'When a membership is created' },
  { event: 'subscription.cancelled', description: 'When a subscription is cancelled' },
];

// ── Delivery Attempt ──
// Mirrors WebhookDeliveryAttemptSerializer.many (the sec-r4-D6 list projection) field for
// field. `id` and `webhook_id` are ABSENT on purpose: sec-T #17 strips both bigserials before
// the response leaves the server, so documenting them told clients to read values that are
// never sent — and implied the platform leaks internal ids. `payload` and `response_body` are
// likewise excluded from the list shape.
export const deliveryAttemptSchema = {
  type: 'object',
  properties: {
    event_type: { type: 'string' },
    event_key: { type: 'string', nullable: true },
    status: { type: 'string', enum: ['PENDING', 'SENT', 'FAILED'] },
    http_status_code: { type: 'integer', nullable: true },
    sent_at: { type: 'string', format: 'date-time', nullable: true },
    attempt_count: { type: 'integer' },
    next_retry_at: { type: 'string', format: 'date-time', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
  },
};

export const deliveryAttemptExample = {
  event_type: 'subscription.created',
  event_key: 'sub_p5q8w1r4x9k3m7n2a1b2c',
  status: 'SENT',
  http_status_code: 200,
  sent_at: '2026-02-14T10:00:00.000Z',
  attempt_count: 1,
  next_retry_at: null,
  created_at: '2026-02-14T10:00:00.000Z',
};

// ── Audit Log ──
export const auditLogSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    organization_id: { type: 'string', nullable: true },
    actor_user_id: { type: 'string' },
    resource_type: { type: 'string' },
    resource_id: { type: 'string' },
    action: { type: 'string' },
    metadata: { type: 'object', nullable: true },
    ip_address: { type: 'string', nullable: true },
    user_agent: { type: 'string', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
  },
};

export const auditLogExample = {
  id: 'log_t6m3n7p2q8w5k1r4',
  organization_id: 'org_k7x9m2pqr4w8n1v3a1b2c',
  actor_user_id: 'usr_k7x9m2pqr4w8n1v3a1b2c',
  resource_type: 'organization',
  resource_id: 'org_k7x9m2pqr4w8n1v3a1b2c',
  action: 'organization.updated',
  metadata: { changes: { name: { from: 'Old Name', to: 'Acme Corporation' } } },
  ip_address: '203.0.113.42',
  user_agent: 'Mozilla/5.0',
  created_at: '2026-02-14T10:00:00.000Z',
};

// ── Upload ──
export const uploadSchema = {
  type: 'object',
  properties: {
    upload_url: { type: 'string', format: 'uri' },
    key: { type: 'string' },
    expires_at: { type: 'string', format: 'date-time' },
  },
};

export const uploadExample = {
  upload_url: 'https://s3.amazonaws.com/bucket/avatars/usr_abc123.png?X-Amz-Algorithm=...',
  key: 'avatars/usr_k7x9m2pqr4w8n1v3a1b2c.png',
  expires_at: '2026-02-14T11:30:00.000Z',
};

// ── Upload object (get / confirm) ──
export const uploadObjectSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '^upl_[a-z0-9]{21}$' },
    file_name: { type: 'string' },
    mime_type: { type: 'string' },
    file_size: { type: 'integer' },
    status: { type: 'string', example: 'UPLOADED' },
    storage_provider: { type: 'string' },
    organization_id: { type: 'string', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

export const uploadObjectExample = {
  id: 'upl_k7x9m2pqr4w8n1v3a1b2c',
  file_name: 'avatar.png',
  mime_type: 'image/png',
  file_size: 1024,
  status: 'UPLOADED',
  storage_provider: 's3',
  organization_id: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

// ── Test webhook response ──
export const webhookTestSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    status_code: { type: 'integer', nullable: true },
    response_time_ms: { type: 'integer', nullable: true },
    error_message: { type: 'string', nullable: true },
  },
};

export const webhookTestExample = {
  success: true,
  status_code: 200,
  response_time_ms: 180,
  error_message: null,
};
