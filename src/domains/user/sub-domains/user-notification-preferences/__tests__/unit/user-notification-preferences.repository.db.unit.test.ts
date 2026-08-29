import { describe, it, expect, beforeEach } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { database } from '@/infrastructure/database/connection.js';
import { user_notification_preferences } from '@/domains/user/sub-domains/user-notification-preferences/user-notification-preferences.schema.js';
import { UserNotificationPreferencesRepository } from '@/domains/user/sub-domains/user-notification-preferences/user-notification-preferences.repository.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

describe('UserNotificationPreferencesRepository (database)', () => {
  const repository = new UserNotificationPreferencesRepository();

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('lists and replaces notification preferences for user', async () => {
    const user = await createTestUser();

    const initial = await repository.listByUserId(user.id);
    expect(initial).toHaveLength(0);

    const inserted = await repository.replaceAll(
      user.id,
      [
        {
          notification_type: 'SUBSCRIPTION_UPDATED',
          channel: 'EMAIL',
          organization_id: null,
          is_enabled: true,
        },
        {
          notification_type: 'INVITATION',
          channel: 'IN_APP',
          organization_id: null,
          is_enabled: false,
        },
      ],
      user.id,
    );
    expect(inserted).toHaveLength(2);

    const listed = await repository.listByUserId(user.id);
    expect(listed).toHaveLength(2);

    const replaced = await repository.replaceAll(user.id, [
      {
        notification_type: 'SUBSCRIPTION_UPDATED',
        channel: 'EMAIL',
        organization_id: null,
        is_enabled: false,
      },
    ]);
    expect(replaced).toHaveLength(1);

    const cleared = await repository.replaceAll(user.id, []);
    expect(cleared).toHaveLength(0);
  });

  it('audit-#11: replaceAll dedupes duplicate (type, channel) tuples — last wins — so the unique index holds', async () => {
    const user = await createTestUser();

    // A payload that repeats the same (notification_type, channel) tuple would
    // previously insert two conflicting rows (and now would violate the new
    // idx_user_notif_prefs_user_type_channel_unique). The repository collapses it.
    const rows = await repository.replaceAll(user.id, [
      {
        notification_type: 'SUBSCRIPTION_UPDATED',
        channel: 'EMAIL',
        organization_id: null,
        is_enabled: true,
      },
      {
        notification_type: 'SUBSCRIPTION_UPDATED',
        channel: 'EMAIL',
        organization_id: null,
        is_enabled: false,
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_enabled).toBe(false); // last occurrence wins
    const listed = await repository.listByUserId(user.id);
    expect(listed).toHaveLength(1);
  });

  // sec-U7: defense-in-depth pin on `organization_id`. The original RLS
  // policy carried an organization branch that only verified the `app.current_organization_public_id`
  // GUC matched, NOT membership — a future route wrapping this table in
  // `withAppDatabaseContext` would have let any user write
  // preferences against any organization id they could assert (historically the removed header),
  // bypassing membership entirely. The schema-level CHECK constraint
  // (`chk_user_notif_prefs_no_org`) refuses non-null `organization_id`
  // outright so even a direct raw-SQL bypass of the application guard
  // cannot land a row scoped to an organization.
  it('rejects a direct insert with non-null organization_id via the CHECK constraint (sec-U7)', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });

    // Raw insert via the privileged test connection — RLS does not apply at
    // this role, so only the CHECK constraint can refuse the write. This
    // simulates a future hostile/buggy code path attempting to persist an
    // organization-scoped preference outside the membership-gated route.
    await expect(
      database.insert(user_notification_preferences).values({
        user_id: user.id,
        organization_id: organization.id,
        notification_type: 'SUBSCRIPTION_UPDATED',
        channel: 'EMAIL',
        is_enabled: true,
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ constraint_name: 'chk_user_notif_prefs_no_org' }),
    });
  });

  // load-test regression: PUT /users/me/notification-preferences returned HTTP 500 under
  // concurrency — Postgres 23505 on idx_user_notif_prefs_user_type_channel_unique (plus the
  // odd 40001) because replaceAll's delete-then-insert raced when the same user was written by
  // two requests at once (surfaced at 150 VU > the 120-user load pool). The per-user advisory
  // lock serializes them: concurrent replaces must all succeed and converge to one full set.
  it('serializes concurrent replaceAll for one user — no 23505/500 under the unique index', async () => {
    const user = await createTestUser();
    const payload = (enabled: boolean) => [
      {
        notification_type: 'SUBSCRIPTION_UPDATED',
        channel: 'EMAIL',
        organization_id: null,
        is_enabled: enabled,
      },
      {
        notification_type: 'INVITATION',
        channel: 'IN_APP',
        organization_id: null,
        is_enabled: enabled,
      },
    ];

    // Fire many simultaneous full-replaces for the SAME user, each in its own request
    // transaction (mirrors concurrent PUTs). Before the advisory lock these raced the unique
    // index and at least one rejected with 23505; the lock makes them all resolve.
    const CONCURRENT_REPLACES = 8;
    const settled = await Promise.allSettled(
      Array.from({ length: CONCURRENT_REPLACES }, (_, index) =>
        withAppDatabaseContext(PRINCIPAL_SCOPE.VERIFIED({ userPublicId: user.public_id }), () =>
          repository.replaceAll(user.id, payload(index % 2 === 0), user.id),
        ),
      ),
    );

    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(0);

    // Exactly one full replace won — deterministic end state, no duplicate tuples.
    const listed = await repository.listByUserId(user.id);
    expect(listed).toHaveLength(2);
  });
});
