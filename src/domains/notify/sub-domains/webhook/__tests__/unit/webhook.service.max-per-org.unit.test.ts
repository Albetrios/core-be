import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Blanket maintenance passthrough: services this suite touches (directly or via
    // cross-domain imports) may enter maintenance contexts (tombstoning, admin reads) —
    // the real wrapper opens a database.transaction() and CI's unit lane has no Postgres.
    withMaintenanceDatabaseContext: vi.fn(
      async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
    ),
    withPrincipalDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

vi.mock(
  '@/domains/notify/sub-domains/webhook/webhook-delivery/events/webhook-delivery-emit.js',
  () => ({ emitWebhookDeliveryRequested: vi.fn().mockResolvedValue(undefined) }),
);

vi.mock('@/shared/utils/security/webhook-outbound-fetch.util.js', () => ({
  resolveAndPinWebhookUrl: vi.fn().mockResolvedValue({
    parsed: new URL('https://example.com/hook'),
    pinnedAddress: '93.184.216.34',
    port: 443,
  }),
}));

vi.mock('@/shared/utils/security/field-secret-encryption.util.js', async () => ({
  encryptFieldSecret: vi.fn((value: string) => `enc:${value}`),
  decryptFieldSecret: vi.fn(() => 'test-signing-secret'),
}));

import { ConflictError } from '@/shared/errors/index.js';
import { WebhookService } from '@/domains/notify/sub-domains/webhook/webhook.service.js';
import {
  createPrincipalDatabaseScope,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { WebhookRepository } from '@/domains/notify/sub-domains/webhook/webhook.repository.js';
import type { WebhookDeliveryAttemptRepository } from '@/domains/notify/sub-domains/webhook/webhook-delivery/webhook-delivery-attempt.repository.js';

/**
 * Regression for sec-N4 (Medium): a single organization could register an
 * unbounded number of webhooks within their per-route rate-limit budget — no
 * absolute count cap. A fully-rate-limit-compliant attacker could pile up
 * thousands of subscriber rows pointing at attacker-controlled hosts, turning
 * every business event into an N-fold signed-POST amplifier.
 *
 * The service now consults `WEBHOOK_MAX_PER_ORG` (env, default 25) before
 * insert and rejects further creates with `ConflictError(errors:webhookMaxReached)`.
 *
 * The matching fan-out cap (defense in depth — the loop must not silently
 * exceed the create cap) lives at the repository level and is asserted in a
 * separate DB-backed test.
 */
describe('WebhookService.create — per-organization cap (sec-N4)', () => {
  const organization = { id: 1, public_id: 'org_public' };
  const scope = createPrincipalDatabaseScope({
    userPublicId: 'user_public',
    organizationPublicId: 'org_public',
    source: 'token',
  }) as OrganizationPrincipalDatabaseScope;

  const webhook = {
    id: 2,
    public_id: 'webhook_public',
    url: 'https://example.com/hook',
    organization_id: 1,
    encrypted_secret: 'enc:secret',
    events: ['subscription.updated'],
    is_enabled: true,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  };

  const organizationService = {
    requireOrganizationByPublicId: vi.fn().mockResolvedValue(organization),
    resolveUserInternalIdByPublicId: vi.fn().mockResolvedValue(10),
  } as unknown as OrganizationService;

  const webhookRepository = {
    create: vi.fn().mockResolvedValue(webhook),
    countActiveByOrganization: vi.fn().mockResolvedValue(0),
    // audit-#8: per-org creation quota advisory lock (no-op in unit tests).
    acquireCreationQuotaLock: vi.fn().mockResolvedValue(undefined),
  } as unknown as WebhookRepository;

  const deliveryAttemptRepository = {} as unknown as WebhookDeliveryAttemptRepository;

  const service = new WebhookService(
    organizationService,
    webhookRepository,
    deliveryAttemptRepository,
  );

  beforeEach(() => {
    vi.mocked(webhookRepository.create).mockClear();
    vi.mocked(webhookRepository.countActiveByOrganization).mockReset();
  });

  it('allows create when the org is below the cap', async () => {
    vi.mocked(webhookRepository.countActiveByOrganization).mockResolvedValue(5);
    await service.create(
      scope,
      {
        url: 'https://example.com/hook',
        events: ['subscription.updated'],
        secret: 'sixteenCharSecret',
      },
      'user_public',
    );
    expect(webhookRepository.create).toHaveBeenCalledTimes(1);
  });

  it('rejects create when the org is at the cap (default 25)', async () => {
    vi.mocked(webhookRepository.countActiveByOrganization).mockResolvedValue(25);
    await expect(
      service.create(
        scope,
        {
          url: 'https://example.com/hook',
          events: ['subscription.updated'],
          secret: 'sixteenCharSecret',
        },
        'user_public',
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(webhookRepository.create).not.toHaveBeenCalled();
  });

  it('rejects create when the org is over the cap (defensive)', async () => {
    vi.mocked(webhookRepository.countActiveByOrganization).mockResolvedValue(30);
    await expect(
      service.create(
        scope,
        {
          url: 'https://example.com/hook',
          events: ['subscription.updated'],
          secret: 'sixteenCharSecret',
        },
        'user_public',
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
