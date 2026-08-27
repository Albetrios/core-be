import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processNotificationDispatchJob } from '@/domains/notify/sub-domains/notification/workers/notification.worker.js';
import type { NotificationRepository } from '@/domains/notify/sub-domains/notification/notification.repository.js';

vi.mock(
  '@/infrastructure/database/contexts/maintenance-database.context.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const inner = ((...parameters: unknown[]) =>
      withGlobalAdminDatabaseContextMock(...parameters)) as unknown as (
      ...parameters: unknown[]
    ) => unknown;
    return {
      ...actual,
      withMaintenanceDatabaseContext: vi.fn((_scope: unknown, ...parameters: unknown[]) =>
        inner(...parameters),
      ),
    };
  },
);

const recordOutboxEmailMock = vi.fn();
const dispatchOutboxEmailMock = vi.fn();
const isMailConfiguredMock = vi.fn();
const isNotificationEmailDispatchedMock = vi.fn();
const markNotificationEmailDispatchedMock = vi.fn();

const withGlobalAdminDatabaseContextMock = vi.fn();
const withUserDatabaseContextMock = vi.fn();
const withOrganizationContextMock = vi.fn();
const createWorkerNotificationRepositoryMock = vi.fn();

vi.mock('@/infrastructure/mail/queues/mail.queue.js', () => ({
  recordOutboxEmail: (...parameters: unknown[]) => recordOutboxEmailMock(...parameters),
  dispatchOutboxEmail: (...parameters: unknown[]) => dispatchOutboxEmailMock(...parameters),
}));

vi.mock(
  '@/domains/notify/sub-domains/notification/workers/notification-email-idempotency.js',
  () => ({
    isNotificationEmailDispatched: (...parameters: unknown[]) =>
      isNotificationEmailDispatchedMock(...parameters),
    markNotificationEmailDispatched: (...parameters: unknown[]) =>
      markNotificationEmailDispatchedMock(...parameters),
  }),
);

vi.mock('@/infrastructure/database/contexts/worker-database.context.js', () => ({
  withSystemTableWorkerContext: (callback: () => Promise<unknown>) => callback(),
}));

vi.mock('@/infrastructure/database/contexts/user-database.context.js', () => ({
  withUserDatabaseContext: (...parameters: unknown[]) => withUserDatabaseContextMock(...parameters),
}));

vi.mock(
  '@/infrastructure/database/contexts/principal-database.context.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      // Arg-shift adapter: the org-branch spy keeps its (organizationPublicId, callback)
      // signature so the existing implementations and assertions stay valid.
      withPrincipalDatabaseContext: vi.fn(
        (
          scope: { organizationPublicId?: string },
          callback: (handle: unknown) => Promise<unknown>,
        ) => withOrganizationContextMock(scope.organizationPublicId, callback),
      ),
    };
  },
);

vi.mock('@/domains/notify/sub-domains/notification/notification.repository.js', () => ({
  createWorkerNotificationRepository: (...parameters: unknown[]) =>
    createWorkerNotificationRepositoryMock(...parameters),
}));

vi.mock('@/infrastructure/mail/mail.service.js', () => ({
  isMailConfigured: () => isMailConfiguredMock(),
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function createNotificationRepository(row: unknown): NotificationRepository {
  return {
    findByIdForDispatch: vi.fn().mockResolvedValue(row),
  } as unknown as NotificationRepository;
}

function buildNotificationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 10,
    type: 'billing.invoice_ready',
    title: 'Invoice ready',
    message: 'Your invoice is ready.',
    actionUrl: 'https://app.example.com/invoices/1',
    userEmail: 'user@example.com',
    data: { channels: ['email', 'in_app'] },
    ...overrides,
  };
}

describe('notification.worker', () => {
  beforeEach(() => {
    recordOutboxEmailMock.mockReset();
    dispatchOutboxEmailMock.mockReset();
    isMailConfiguredMock.mockReset();
    isNotificationEmailDispatchedMock.mockReset();
    markNotificationEmailDispatchedMock.mockReset();
    isMailConfiguredMock.mockReturnValue(true);
    recordOutboxEmailMock.mockResolvedValue(501);
    dispatchOutboxEmailMock.mockResolvedValue(undefined);
    isNotificationEmailDispatchedMock.mockResolvedValue(false);
    markNotificationEmailDispatchedMock.mockResolvedValue(undefined);
  });

  it('queues email and returns in-app channel result when both channels are requested', async () => {
    const repository = createNotificationRepository(buildNotificationRow());

    const result = await processNotificationDispatchJob(
      10,
      'organization_public_id',
      { id: 'job-1', requestId: 'request-1' },
      repository,
    );

    expect(recordOutboxEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        subject: 'Invoice ready',
        tags: [{ name: 'category', value: 'notification-billing.invoice_ready' }],
      }),
    );
    expect(dispatchOutboxEmailMock).toHaveBeenCalledWith(501, { requestId: 'request-1' });
    expect(result).toEqual({ channels: ['email:queued', 'in_app:persisted'] });
  });

  it('sec-N7: sends to the joined row recipient, never a producer-supplied data.email (email-hijack guard)', async () => {
    // `data` is `Record<string, unknown>`; a domain handler that reflected request input into it
    // could smuggle an `email` field. The worker must ALWAYS use the notification row's joined
    // `auth.users.email` and ignore `data.email`, or system mail is redirected to an attacker inbox.
    const repository = createNotificationRepository(
      buildNotificationRow({
        userEmail: 'real@user.com',
        data: { channels: ['email'], email: 'attacker@evil.com' },
      }),
    );

    await processNotificationDispatchJob(
      10,
      'organization_public_id',
      { id: 'job-hijack', requestId: 'request-1' },
      repository,
    );

    expect(recordOutboxEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'real@user.com' }),
    );
    expect(recordOutboxEmailMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: 'attacker@evil.com' }),
    );
  });

  it('does not enqueue a duplicate email when a prior run already durably dispatched (audit-#7)', async () => {
    isNotificationEmailDispatchedMock.mockResolvedValue(true);
    const repository = createNotificationRepository(buildNotificationRow());

    const result = await processNotificationDispatchJob(
      10,
      'organization_public_id',
      { id: 'job-retry', requestId: 'request-1' },
      repository,
    );

    expect(isNotificationEmailDispatchedMock).toHaveBeenCalledWith({
      notificationId: 10,
      recipient: 'user@example.com',
    });
    expect(recordOutboxEmailMock).not.toHaveBeenCalled();
    expect(dispatchOutboxEmailMock).not.toHaveBeenCalled();
    expect(markNotificationEmailDispatchedMock).not.toHaveBeenCalled();
    expect(result).toEqual({ channels: ['email:deduplicated', 'in_app:persisted'] });
  });

  it('marks dispatched AFTER persisting the outbox row, and returns email:outbox_pending when the BullMQ enqueue fails (audit-#7 / #45)', async () => {
    // Durability-first: the outbox row is written, the dedup marker is set, then the
    // (best-effort) enqueue runs. A dispatch failure after the durable row lands must
    // not throw — the mail-outbox sweeper re-enqueues stale pending rows. audit #45:
    // the outcome must report `email:outbox_pending`, not `email:queued`, so the
    // persisted-but-undelivered state is not masked as a successful send.
    dispatchOutboxEmailMock.mockRejectedValueOnce(new Error('redis down'));
    const repository = createNotificationRepository(buildNotificationRow());

    const result = await processNotificationDispatchJob(
      10,
      'organization_public_id',
      { id: 'job-1' },
      repository,
    );

    expect(recordOutboxEmailMock).toHaveBeenCalledTimes(1);
    // The dedup marker is set ONLY after the durable insert succeeds.
    expect(markNotificationEmailDispatchedMock).toHaveBeenCalledWith({
      notificationId: 10,
      recipient: 'user@example.com',
    });
    expect(recordOutboxEmailMock.mock.invocationCallOrder[0]!).toBeLessThan(
      markNotificationEmailDispatchedMock.mock.invocationCallOrder[0]!,
    );
    expect(dispatchOutboxEmailMock).toHaveBeenCalledTimes(1);
    expect(result.channels).toContain('email:outbox_pending');
    expect(result.channels).not.toContain('email:queued');
  });

  it('rethrows and does NOT mark dispatched when the outbox INSERT itself fails so BullMQ retries (audit-#7)', async () => {
    // The recordOutboxEmail call is the durability commit; if it fails, NO outbox row
    // exists and NO marker is written, so a BullMQ retry re-inserts — the email is never
    // lost (the previous claim-before-insert model would have skipped the retry).
    recordOutboxEmailMock.mockRejectedValueOnce(new Error('postgres down'));
    const repository = createNotificationRepository(buildNotificationRow());

    await expect(
      processNotificationDispatchJob(10, 'organization_public_id', { id: 'job-1' }, repository),
    ).rejects.toThrow('postgres down');

    expect(markNotificationEmailDispatchedMock).not.toHaveBeenCalled();
    // Dispatch was never reached because the INSERT failed first.
    expect(dispatchOutboxEmailMock).not.toHaveBeenCalled();
  });

  it('escapes untrusted notification fields and drops unsafe action URLs in the email HTML', async () => {
    const repository = createNotificationRepository(
      buildNotificationRow({
        title: '<script>alert(1)</script>',
        message: 'Hello <img src=x onerror=alert(1)>',
        actionUrl: 'javascript:alert(document.cookie)',
      }),
    );

    await processNotificationDispatchJob(
      10,
      'organization_public_id',
      { id: 'job-1', requestId: 'request-1' },
      repository,
    );

    const emailPayload = recordOutboxEmailMock.mock.calls[0]?.[0] as { html: string };
    expect(emailPayload.html).not.toContain('<script>alert(1)</script>');
    expect(emailPayload.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(emailPayload.html).not.toContain('<img src=x');
    expect(emailPayload.html).not.toContain('href="javascript:');
    expect(emailPayload.html).not.toContain('class="button"');
  });

  it('skips email channel when mail is not configured', async () => {
    isMailConfiguredMock.mockReturnValue(false);
    const repository = createNotificationRepository(buildNotificationRow());

    const result = await processNotificationDispatchJob(
      10,
      'organization_public_id',
      { id: 'job-1' },
      repository,
    );

    expect(recordOutboxEmailMock).not.toHaveBeenCalled();
    expect(dispatchOutboxEmailMock).not.toHaveBeenCalled();
    expect(result).toEqual({ channels: ['in_app:persisted'] });
  });

  it('defaults to in-app delivery when channels are absent', async () => {
    const repository = createNotificationRepository(buildNotificationRow({ data: {} }));

    const result = await processNotificationDispatchJob(10, null, { id: 'job-1' }, repository);

    expect(recordOutboxEmailMock).not.toHaveBeenCalled();
    expect(result).toEqual({ channels: ['in_app:persisted'] });
  });

  it('throws when the notification cannot be loaded', async () => {
    const repository = createNotificationRepository(null);

    await expect(
      processNotificationDispatchJob(999, null, { id: 'job-1' }, repository),
    ).rejects.toThrow('notification.not_found:999');
  });

  describe('sec-re-01: tenant-less notifications enter loadNotificationForScope', () => {
    // The sec-D #10 fix added a `loadNotificationForScope` flow that pins
    // `withUserDatabaseContext` for tenant-less notifications (instead of the prior
    // `runGlobalRetentionWorkerJob` retention GUC). The sec-re-01 regression caught
    // that the worker wiring still injected a repository, which short-circuited the
    // new flow at `notificationRepository !== undefined` so production behavior was
    // unchanged from before PR #450. These tests pin the recipient-resolution and
    // narrow-context behavior so future wiring changes can't silently re-introduce
    // the dead-code path.
    beforeEach(() => {
      withGlobalAdminDatabaseContextMock.mockReset();
      withUserDatabaseContextMock.mockReset();
      withOrganizationContextMock.mockReset();
      createWorkerNotificationRepositoryMock.mockReset();

      withGlobalAdminDatabaseContextMock.mockImplementation(
        async (callback: (handle: unknown) => Promise<unknown>) => callback({}),
      );
      withUserDatabaseContextMock.mockImplementation(
        async (_userPublicId: string, callback: (handle: unknown) => Promise<unknown>) =>
          callback({}),
      );
      withOrganizationContextMock.mockImplementation(
        async (_organizationPublicId: string, callback: (handle: unknown) => Promise<unknown>) =>
          callback({}),
      );
    });

    it('resolves the recipient user public id under global_admin scope and pins withUserDatabaseContext', async () => {
      const findUserPublicIdMock = vi.fn().mockResolvedValue('usr_public_id_42');
      const findByIdMock = vi.fn().mockResolvedValue(buildNotificationRow({ data: {} }));
      createWorkerNotificationRepositoryMock.mockReturnValue({
        findUserPublicIdForNotificationDispatch: findUserPublicIdMock,
        findByIdForDispatch: findByIdMock,
      });

      const result = await processNotificationDispatchJob(
        42,
        null,
        { id: 'job-1', requestId: 'req-1' },
        // NB: no 4th argument — this is the wiring shape after sec-re-01.
      );

      expect(withGlobalAdminDatabaseContextMock).toHaveBeenCalledTimes(1);
      expect(findUserPublicIdMock).toHaveBeenCalledWith(42);
      expect(withUserDatabaseContextMock).toHaveBeenCalledWith(
        'usr_public_id_42',
        expect.any(Function),
      );
      expect(findByIdMock).toHaveBeenCalledWith(42, null);
      // No tenant scope means withOrganizationContext is never touched.
      expect(withOrganizationContextMock).not.toHaveBeenCalled();
      expect(result).toEqual({ channels: ['in_app:persisted'] });
    });

    it('throws notification.user_unknown when the SECURITY DEFINER lookup returns null', async () => {
      createWorkerNotificationRepositoryMock.mockReturnValue({
        findUserPublicIdForNotificationDispatch: vi.fn().mockResolvedValue(null),
        findByIdForDispatch: vi.fn(),
      });

      await expect(processNotificationDispatchJob(999, null, { id: 'job-1' })).rejects.toThrow(
        'notification.user_unknown:999',
      );
    });

    it('uses withOrganizationContext (not the user-scope path) when organizationPublicId is set and no repo is injected', async () => {
      const findByIdMock = vi.fn().mockResolvedValue(buildNotificationRow({ data: {} }));
      createWorkerNotificationRepositoryMock.mockReturnValue({
        findUserPublicIdForNotificationDispatch: vi.fn(),
        findByIdForDispatch: findByIdMock,
      });

      await processNotificationDispatchJob(
        7,
        'organization_public_id',
        { id: 'job-1' },
        // No injected repo — exercises loadNotificationForScope's tenant branch.
      );

      expect(withOrganizationContextMock).toHaveBeenCalledWith(
        'organization_public_id',
        expect.any(Function),
      );
      // The global-admin / user pair are exclusive to the tenant-less branch.
      expect(withGlobalAdminDatabaseContextMock).not.toHaveBeenCalled();
      expect(withUserDatabaseContextMock).not.toHaveBeenCalled();
      expect(findByIdMock).toHaveBeenCalledWith(7, 'organization_public_id');
    });
  });
});
