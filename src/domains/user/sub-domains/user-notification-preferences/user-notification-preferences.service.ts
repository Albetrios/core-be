import { NotFoundError, ValidationError } from '@/shared/errors/index.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { UserNotificationPreferencesRepository } from './user-notification-preferences.repository.js';
import { serializeUserNotificationPreferenceList } from './user-notification-preferences.serializer.js';
import type { NotificationPreferenceOutput } from './user-notification-preferences.types.js';
import { validatePutUserNotificationPreferences } from './user-notification-preferences.validator.js';
import {
  withAppDatabaseContext,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

/**
 * Read and replace the authenticated user's notification opt-ins per `(type, channel, organization?)`.
 *
 * @remarks
 * - **Algorithm:** resolve the user via {@link UserService.findUserRecordByPublicId}, then run the
 *   repository call inside `withAppDatabaseContext (user scope)` so RLS scopes the SELECT/DELETE/INSERT to the
 *   owning user. `put` validates first, then cascades by deleting all existing rows for the user
 *   and inserting the supplied list in one repository call.
 * - **Failure modes:** unknown / soft-deleted user → {@link NotFoundError}; invalid body →
 *   {@link ValidationError} from the validator; channel values violating the schema CHECK
 *   constraint surface as a Postgres error.
 * - **Side effects:** writes to `auth.user_notification_preferences`. No event emission today —
 *   downstream notification dispatch reads the latest rows directly.
 * - **Notes:** replace-all semantics intentionally deletes preferences not present in the request,
 *   so partial updates require sending the full set.
 */
export class UserNotificationPreferencesService {
  constructor(
    private readonly userService: UserService,
    private readonly repository: UserNotificationPreferencesRepository,
  ) {}

  /**
   * Resolves the owner's internal id. MUST be called inside the caller's database context — it
   * joins that transaction rather than opening a second one just to turn a public id the request
   * already carries into the internal id (see {@link UserService.resolveInternalIdByPublicId}).
   */
  private async requireUserIdInContext(user_public_id: string): Promise<number> {
    const userId = await this.userService.resolveInternalIdByPublicId(user_public_id);
    if (userId === null) throw new NotFoundError('User');
    return userId;
  }

  async get(scope: UserPrincipalDatabaseScope): Promise<NotificationPreferenceOutput[]> {
    const user_public_id = scope.userPublicId;
    const rows = await withAppDatabaseContext(scope, async () =>
      this.repository.listByUserId(await this.requireUserIdInContext(user_public_id)),
    );
    return serializeUserNotificationPreferenceList(rows);
  }

  async put(
    scope: UserPrincipalDatabaseScope,
    body: unknown,
  ): Promise<NotificationPreferenceOutput[]> {
    const user_public_id = scope.userPublicId;
    const parsed = validatePutUserNotificationPreferences(body);
    // This is the user-scoped endpoint (/users/me/*) with no tenant context, so a non-null
    // organization_id can never satisfy the organization branch of the RLS WITH CHECK policy and would
    // surface as a raw 42501 -> 500. Reject it as a 400 instead. Organization-scoped notification
    // policy is a separate tenancy feature (organization-notification-policy); user-level prefs
    // here are global.
    if (parsed.preferences.some((preference) => preference.organization_id != null)) {
      throw new ValidationError('errors:validation.invalidInput', undefined, {
        organization_id:
          'Organization-scoped notification preferences are not settable on this endpoint',
      });
    }
    const rows = await withAppDatabaseContext(scope, async () => {
      const userId = await this.requireUserIdInContext(user_public_id);
      return this.repository.replaceAll(
        userId,
        parsed.preferences.map((preference) => ({
          notification_type: preference.notification_type,
          channel: preference.channel,
          organization_id: preference.organization_id ?? null,
          is_enabled: preference.is_enabled,
        })),
        userId,
      );
    });
    return serializeUserNotificationPreferenceList(rows);
  }
}
