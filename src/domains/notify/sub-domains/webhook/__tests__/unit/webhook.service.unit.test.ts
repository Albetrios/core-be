import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPinnedFetch, createPinnedWebhookFetchMock } = vi.hoisted(() => ({
  mockPinnedFetch: vi.fn(),
  createPinnedWebhookFetchMock: vi.fn(),
}));

vi.mock('@/infrastructure/database/contexts/organization-database.context.js', () => ({
  withOrganizationDatabaseContext: vi.fn(
    async (_organizationPublicId: string, callback: () => Promise<unknown>) => callback(),
  ),
}));

vi.mock(
  '@/infrastructure/database/contexts/principal-database.context.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      withPrincipalDatabaseContext: vi.fn(
        async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
      ),
    };
  },
);

import {
  ConfigurationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '@/shared/errors/index.js';
import { WebhookService } from '@/domains/notify/sub-domains/webhook/webhook.service.js';
import {
  createPrincipalDatabaseScope,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/principal-database.context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { WebhookRepository } from '@/domains/notify/sub-domains/webhook/webhook.repository.js';
import type { WebhookDeliveryAttemptRepository } from '@/domains/notify/sub-domains/webhook/webhook-delivery/webhook-delivery-attempt.repository.js';
import type * as FieldSecretEncryptionModule from '@/shared/utils/security/field-secret-encryption.util.js';

vi.mock(
  '@/domains/notify/sub-domains/webhook/webhook-delivery/events/webhook-delivery-emit.js',
  () => ({
    emitWebhookDeliveryRequested: vi.fn().mockResolvedValue(undefined),
  }),
);

vi.mock('@/shared/utils/security/webhook-outbound-fetch.util.js', () => ({
  createPinnedWebhookFetch: createPinnedWebhookFetchMock,
  resolveAndPinWebhookUrl: vi.fn().mockResolvedValue({
    parsed: new URL('https://example.com/hook'),
    pinnedAddress: '93.184.216.34',
    port: 443,
  }),
}));

vi.mock('@/shared/utils/security/field-secret-encryption.util.js', async (importOriginal) => ({
  ...(await importOriginal<typeof FieldSecretEncryptionModule>()),
  decryptFieldSecret: vi.fn(() => 'test-signing-secret'),
}));

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

describe('WebhookService', () => {
  const organizationService = {
    requireOrganizationByPublicId: vi.fn().mockResolvedValue(organization),
    resolveUserInternalIdByPublicId: vi.fn().mockResolvedValue(10),
  } as unknown as OrganizationService;

  const webhookRepository = {
    listByOrganization: vi.fn().mockResolvedValue({
      items: [webhook],
      total: null,
      limit: 25,
      has_more: false,
      next_cursor: null,
    }),
    findByPublicId: vi.fn().mockResolvedValue(webhook),
    // NOTIFY-11: the secret-rotation gate reads under a FOR UPDATE row lock.
    findByPublicIdForUpdate: vi.fn().mockResolvedValue(webhook),
    create: vi.fn().mockResolvedValue(webhook),
    update: vi.fn().mockResolvedValue(webhook),
    softDelete: vi.fn().mockResolvedValue(webhook),
    listEnabledSubscribedToEvent: vi.fn().mockResolvedValue([]),
    // sec-N4: service consults this before insert; default to 0 so existing
    // happy-path tests stay below the cap.
    countActiveByOrganization: vi.fn().mockResolvedValue(0),
    // audit-#8: per-org creation quota advisory lock (no-op in unit tests).
    acquireCreationQuotaLock: vi.fn().mockResolvedValue(undefined),
  } as unknown as WebhookRepository;

  const deliveryAttemptRepository = {
    getWebhookId: vi.fn().mockResolvedValue(webhook.id),
    listByWebhook: vi.fn().mockResolvedValue({
      items: [],
      total: null,
      limit: 10,
      has_more: false,
      next_cursor: null,
    }),
    create: vi.fn().mockResolvedValue({ id: 1 }),
    createPending: vi.fn().mockResolvedValue(88),
  } as unknown as WebhookDeliveryAttemptRepository;

  const service = new WebhookService(
    organizationService,
    webhookRepository,
    deliveryAttemptRepository,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(webhookRepository.findByPublicId).mockResolvedValue(webhook as never);
    vi.mocked(webhookRepository.findByPublicIdForUpdate).mockResolvedValue(webhook as never);
    vi.mocked(webhookRepository.update).mockResolvedValue(webhook as never);
    vi.mocked(webhookRepository.softDelete).mockResolvedValue(webhook as never);
    createPinnedWebhookFetchMock.mockResolvedValue(mockPinnedFetch);
    mockPinnedFetch.mockReset();
  });

  it('lists, gets, creates, updates, and deletes webhooks', async () => {
    const listed = await service.list({ scope });
    expect(listed.items).toHaveLength(1);
    await service.get(scope, 'webhook_public');
    await service.create(
      scope,
      {
        url: 'https://example.com/hook',
        events: ['subscription.updated'],
        secret: 'sixteenCharSecret',
      },
      'user_public',
    );
    await service.update(scope, 'webhook_public', { is_enabled: false }, 'user_public');
    await service.delete(scope, 'webhook_public');
    expect(webhookRepository.softDelete).toHaveBeenCalled();
  });

  it('listDeliveryAttempts resolves webhook id', async () => {
    await service.listDeliveryAttempts({
      scope,
      webhook_public_id: 'webhook_public',
      limit: 10,
    });
    expect(deliveryAttemptRepository.listByWebhook).toHaveBeenCalledWith(
      webhook.id,
      expect.objectContaining({ limit: 10 }),
    );
  });

  it('listDeliveryAttempts throws when webhook missing', async () => {
    vi.mocked(deliveryAttemptRepository.getWebhookId).mockResolvedValue(null);
    await expect(
      service.listDeliveryAttempts({
        scope,
        webhook_public_id: 'missing',
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('testWebhook records successful delivery attempt', async () => {
    mockPinnedFetch.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });

    const result = await service.testWebhook({
      scope,
      webhook_public_id: 'webhook_public',
    });
    expect(result.success).toBe(true);
    expect(deliveryAttemptRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'SENT' }),
    );
  });

  it('testWebhook uses the SSRF-pinned fetch and signs the request', async () => {
    mockPinnedFetch.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });

    await service.testWebhook({
      scope,
      webhook_public_id: 'webhook_public',
    });

    expect(createPinnedWebhookFetchMock).toHaveBeenCalledWith(webhook.url);
    expect(mockPinnedFetch).toHaveBeenCalledTimes(1);
    const [, requestInit] = mockPinnedFetch.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(requestInit.headers);
    expect(headers.get('X-Webhook-Signature')).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    expect(headers.get('X-Webhook-Timestamp')).toMatch(/^\d+$/);
  });

  it('P0-#1: testWebhook fail-closes with ConfigurationError when the resolved signing secret is empty', async () => {
    // Previously testWebhook (and the delivery worker) silently shipped the payload
    // without X-Webhook-Signature when the decrypted secret was empty. That leaves
    // the receiver unable to distinguish "secret rotated to empty" from "attacker
    // stripped the header" — a forgery primitive against any verifier still trusting
    // the request. The fail-closed contract: throw a ConfigurationError instead of
    // delivering, page on-call via Sentry, never call the pinned fetch.
    const fieldSecretEncryption = await import(
      '@/shared/utils/security/field-secret-encryption.util.js'
    );
    vi.mocked(fieldSecretEncryption.decryptFieldSecret).mockReturnValueOnce('');

    await expect(
      service.testWebhook({
        scope,
        webhook_public_id: 'webhook_public',
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);

    expect(mockPinnedFetch).not.toHaveBeenCalled();
  });

  it('testWebhook rejects (and records nothing) when the URL is no longer SSRF-safe', async () => {
    createPinnedWebhookFetchMock.mockRejectedValue(
      new ValidationError('errors:webhookUrlNotAllowed'),
    );

    await expect(
      service.testWebhook({
        scope,
        webhook_public_id: 'webhook_public',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(mockPinnedFetch).not.toHaveBeenCalled();
    expect(deliveryAttemptRepository.create).not.toHaveBeenCalled();
  });

  it('testWebhook caps the persisted response body even though the returned body is truncated shorter', async () => {
    const hugeBody = 'y'.repeat(5_000);
    mockPinnedFetch.mockResolvedValue({ ok: true, status: 200, text: async () => hugeBody });

    await service.testWebhook({
      scope,
      webhook_public_id: 'webhook_public',
    });

    const createArgument = vi.mocked(deliveryAttemptRepository.create).mock.calls[0]![0] as {
      response_body: string;
    };
    expect(createArgument.response_body).toHaveLength(2_000);
  });

  it('testWebhook records failed delivery on network error', async () => {
    mockPinnedFetch.mockRejectedValue(new Error('network error'));

    const result = await service.testWebhook({
      scope,
      webhook_public_id: 'webhook_public',
    });
    expect(result.success).toBe(false);
  });

  it('get throws NotFound when webhook is missing', async () => {
    vi.mocked(webhookRepository.findByPublicId).mockResolvedValue(null);
    await expect(service.get(scope, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('update and delete throw NotFound when webhook is missing', async () => {
    vi.mocked(webhookRepository.update).mockResolvedValue(null);
    vi.mocked(webhookRepository.softDelete).mockResolvedValue(null);
    await expect(
      service.update(scope, 'missing', { is_enabled: false }, 'user_public'),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.delete(scope, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('testWebhook throws NotFound when webhook is missing', async () => {
    vi.mocked(webhookRepository.findByPublicId).mockResolvedValue(null);
    await expect(
      service.testWebhook({
        scope,
        webhook_public_id: 'missing',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('testWebhook treats unreadable response body as null', async () => {
    mockPinnedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('body read failed');
      },
    });
    const result = await service.testWebhook({
      scope,
      webhook_public_id: 'webhook_public',
    });
    expect(result.success).toBe(true);
    expect(result.response_body).toBe('[parse error]');
  });

  it('testWebhook truncates long response bodies', async () => {
    const longBody = 'x'.repeat(600);
    mockPinnedFetch.mockResolvedValue({ ok: true, status: 200, text: async () => longBody });
    const result = await service.testWebhook({
      scope,
      webhook_public_id: 'webhook_public',
    });
    expect(result.response_body).toContain('[truncated]');
  });

  it('requestWebhookDelivery emits delivery event with webhook payload', async () => {
    const { emitWebhookDeliveryRequested } = await import(
      '@/domains/notify/sub-domains/webhook/webhook-delivery/events/webhook-delivery-emit.js'
    );
    await service.requestWebhookDelivery({
      webhookId: 2,
      eventType: 'subscription.updated',
      payload: { id: 'inv_1' },
    });
    expect(emitWebhookDeliveryRequested).toHaveBeenCalledWith({
      webhookId: 2,
      eventType: 'subscription.updated',
      payload: { id: 'inv_1' },
    });
  });

  it('dispatchOrganizationWebhooks requests delivery for each subscribed webhook', async () => {
    vi.mocked(webhookRepository.listEnabledSubscribedToEvent).mockResolvedValue([
      { id: 2, is_enabled: true, events: ['subscription.updated'] },
      { id: 3, is_enabled: true, events: ['subscription.updated'] },
    ] as never);
    const requestWebhookDeliverySpy = vi.spyOn(service, 'requestWebhookDelivery');

    await service.dispatchOrganizationWebhooks(1, 'subscription.updated', {
      subscription_id: 'sub_1',
    });

    expect(requestWebhookDeliverySpy).toHaveBeenCalledTimes(2);
  });

  it('dispatchOrganizationWebhooks isolates a single failing endpoint (best-effort)', async () => {
    vi.mocked(webhookRepository.listEnabledSubscribedToEvent).mockResolvedValue([
      { id: 2, is_enabled: true, events: ['subscription.updated'] },
      { id: 3, is_enabled: true, events: ['subscription.updated'] },
    ] as never);
    const requestWebhookDeliverySpy = vi
      .spyOn(service, 'requestWebhookDelivery')
      .mockImplementation(async ({ webhookId }) => {
        if (webhookId === 2) throw new Error('attempt insert failed');
      });

    await expect(
      service.dispatchOrganizationWebhooks(1, 'subscription.updated', { subscription_id: 'sub_1' }),
    ).resolves.toBeUndefined();
    expect(requestWebhookDeliverySpy).toHaveBeenCalledTimes(2);
  });

  it('dispatchOrganizationWebhooks rethrows when every endpoint fails (retryable)', async () => {
    vi.mocked(webhookRepository.listEnabledSubscribedToEvent).mockResolvedValue([
      { id: 2, is_enabled: true, events: ['subscription.updated'] },
      { id: 3, is_enabled: true, events: ['subscription.updated'] },
    ] as never);
    vi.spyOn(service, 'requestWebhookDelivery').mockRejectedValue(new Error('redis down'));

    await expect(
      service.dispatchOrganizationWebhooks(1, 'subscription.updated', { subscription_id: 'sub_1' }),
    ).rejects.toThrow('redis down');
  });

  it('update encrypts secret when provided in body', async () => {
    await service.update(
      scope,
      'webhook_public',
      { secret: 'new-signing-secret-value' },
      'user_public',
    );
    expect(webhookRepository.update).toHaveBeenCalledWith(
      'webhook_public',
      organization.id,
      expect.objectContaining({ encrypted_secret: expect.stringMatching(/^v1:/) }),
      10,
      // audit-#9: the eligibility cutoff is forwarded so the rotation predicate is enforced atomically.
      expect.objectContaining({ secretRotationOverlapCutoff: expect.any(Date) }),
    );
  });

  it('route-audit/NOTIFY-11: rejects a re-rotation while the previous rotation is still in its overlap window', async () => {
    // secret_rotated_at 1h ago is well within the 24h default dual-sign overlap; rotating again now
    // would evict the still-valid previous secret, so refuse with a conflict and no write. The gate
    // reads under FOR UPDATE so concurrent rotations serialize.
    vi.mocked(webhookRepository.findByPublicId).mockResolvedValueOnce({
      ...webhook,
      secret_rotated_at: new Date(Date.now() - 60 * 60 * 1000),
    } as never);
    await expect(
      service.update(scope, 'webhook_public', { secret: 'another-new-secret-value' }, 'u'),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(webhookRepository.update).not.toHaveBeenCalled();
  });

  it('audit-#9: a secret-rotation race loser (UPDATE matches zero rows after an eligible pre-check) gets a retryable 409, not a 404', async () => {
    // The pre-check passes (no prior rotation on the row it read), but a concurrent rotation wins
    // the atomic eligibility predicate so this UPDATE matches zero rows. The service must re-read
    // and map the loser to a ConflictError with a retry-after — never a misleading NotFoundError.
    vi.mocked(webhookRepository.findByPublicId)
      .mockResolvedValueOnce(webhook as never) // pre-check: eligible (no secret_rotated_at)
      .mockResolvedValueOnce({
        ...webhook,
        secret_rotated_at: new Date(Date.now() - 60 * 60 * 1000), // the winner rotated 1h ago
      } as never);
    vi.mocked(webhookRepository.update).mockResolvedValueOnce(null as never);

    await expect(
      service.update(
        scope,
        'webhook_public',
        { secret: 'race-losing-secret-value' },
        'user_public',
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    // Unlike the pre-check 409, the UPDATE WAS attempted — the race was lost at the DB, not the gate.
    expect(webhookRepository.update).toHaveBeenCalled();
  });

  it('audit-#9: an UPDATE returning null for a VANISHED webhook maps to NotFoundError, not a false 409', async () => {
    vi.mocked(webhookRepository.findByPublicId)
      .mockResolvedValueOnce(webhook as never) // pre-check: eligible
      .mockResolvedValueOnce(null as never); // re-read: the row is gone
    vi.mocked(webhookRepository.update).mockResolvedValueOnce(null as never);

    await expect(
      service.update(
        scope,
        'webhook_public',
        { secret: 'secret-for-vanished-hook' },
        'user_public',
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('route-audit/NOTIFY-11: allows a re-rotation once the previous overlap window has elapsed', async () => {
    vi.mocked(webhookRepository.findByPublicId).mockResolvedValueOnce({
      ...webhook,
      secret_rotated_at: new Date(Date.now() - 48 * 60 * 60 * 1000), // past the 24h window
    } as never);
    await service.update(
      scope,
      'webhook_public',
      { secret: 'another-new-secret-value' },
      'user_public',
    );
    expect(webhookRepository.update).toHaveBeenCalled();
  });

  it('listDeliveryAttempts throws when webhook id is undefined', async () => {
    vi.mocked(deliveryAttemptRepository.getWebhookId).mockResolvedValue(null);
    await expect(
      service.listDeliveryAttempts({
        scope,
        webhook_public_id: 'webhook_public',
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('create passes undefined created_by_user_id when user cannot be resolved', async () => {
    vi.mocked(organizationService.resolveUserInternalIdByPublicId).mockResolvedValue(null);
    await service.create(
      scope,
      { url: 'https://example.com/hook', events: ['subscription.updated'] },
      'unknown_user',
    );
    const createPayload = vi
      .mocked(webhookRepository.create)
      .mock.calls.at(-1)?.[0] as unknown as Record<string, unknown>;
    expect(createPayload).not.toHaveProperty('created_by_user_id');
  });

  it('create auto-generates a 256-bit hex signing secret when the caller omits one (sec-UP #8)', async () => {
    // The existing no-secret test asserts only the created_by field. The security-load-bearing part
    // is that an omitted secret becomes a STRONG one — an empty/weak signing secret makes the HMAC
    // forgeable. encryptFieldSecret is the real impl in this suite (only decryptFieldSecret is
    // stubbed), so the stored ciphertext is genuine and can be reversed with the real decryptor.
    await service.create(
      scope,
      { url: 'https://example.com/hook', events: ['subscription.updated'] },
      'user_public',
    );

    const createPayload = vi.mocked(webhookRepository.create).mock.calls.at(-1)?.[0] as {
      encrypted_secret: string;
    };
    // A real, version-prefixed ciphertext was stored (not an empty/plaintext secret).
    expect(createPayload.encrypted_secret).toContain(':');

    const actual = await vi.importActual<typeof FieldSecretEncryptionModule>(
      '@/shared/utils/security/field-secret-encryption.util.js',
    );
    const generatedSecret = actual.decryptFieldSecret(createPayload.encrypted_secret);
    // 32 random bytes → 64 hex chars → 256 bits of entropy.
    expect(generatedSecret).toMatch(/^[a-f0-9]{64}$/);
  });
});
