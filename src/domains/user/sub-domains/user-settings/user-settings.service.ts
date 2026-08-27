import { NotFoundError } from '@/shared/errors/index.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { UserSettingsRepository } from './user-settings.repository.js';
import { serializeUserSettings } from './user-settings.serializer.js';
import type { UserSettingsOutput } from './user-settings.types.js';
import { validateUpdateUserSettings } from './user-settings.validator.js';
import {
  withPrincipalDatabaseContext,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/principal-database.context.js';
import { resolveVerifiedUserPrincipalScope } from '@/shared/utils/identity/verified-principal-scope.util.js';

/**
 * Read or merge the authenticated user's personalization toggles and locale preferences.
 *
 * @remarks
 * - **Algorithm:** resolve the user via {@link UserService.findUserRecordByPublicId}; `get`
 *   returns the serialized row (or platform defaults if no row exists); `update` validates the
 *   patch, drops `undefined` fields, and asks the repository to upsert-merge over the existing row.
 * - **Failure modes:** unknown user → {@link NotFoundError}; invalid body →
 *   {@link ValidationError} from the validator.
 * - **Side effects:** writes to `auth.user_settings`. No event emission today.
 * - **Notes:** the repository handles defaulting on first write so this service stays patch-only;
 *   `omitUndefined` avoids accidentally clearing fields the client did not send.
 */
export class UserSettingsService {
  constructor(
    private readonly userService: UserService,
    private readonly repository: UserSettingsRepository,
  ) {}

  async get(scope: UserPrincipalDatabaseScope): Promise<UserSettingsOutput> {
    const user_public_id = scope.userPublicId;
    const user = await this.userService.findUserRecordByPublicId(user_public_id);
    if (!user) throw new NotFoundError('User');
    // auth.user_settings is FORCE RLS keyed on app.current_user_id — read inside the user context.
    const settings = await withPrincipalDatabaseContext(scope, () =>
      this.repository.getByUserId(user.id),
    );
    return serializeUserSettings(settings);
  }

  async update(scope: UserPrincipalDatabaseScope, body: unknown): Promise<UserSettingsOutput> {
    const user_public_id = scope.userPublicId;
    const parsed = validateUpdateUserSettings(body);
    const user = await this.userService.findUserRecordByPublicId(user_public_id);
    if (!user) throw new NotFoundError('User');
    // auth.user_settings is FORCE RLS keyed on app.current_user_id — upsert inside the user context.
    const result = await withPrincipalDatabaseContext(scope, () =>
      this.repository.upsert(user.id, omitUndefined(parsed)),
    );
    return serializeUserSettings(result);
  }

  /**
   * Invite-flow port: reads the INVITED user's settings during membership
   * creation — a cross-user read authorized by the invitation write path, where
   * the request principal is the inviter, so no token scope for the invitee can
   * exist. Stays on the user-context wrapper until the pre-token minter lands
   * (Phase 6b of the principal campaign).
   */
  async getForInvitedUser(user_public_id: string): Promise<UserSettingsOutput> {
    const user = await this.userService.findUserRecordByPublicId(user_public_id);
    if (!user) throw new NotFoundError('User');
    const settings = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(user_public_id),
      () => this.repository.getByUserId(user.id),
    );
    return serializeUserSettings(settings);
  }

  /**
   * Invite-flow port: writes locale defaults onto the INVITED user's settings —
   * see {@link UserSettingsService.getForInvitedUser} for why this cross-user
   * write cannot carry a token scope (absorbed in Phase 6b).
   */
  async updateForInvitedUser(user_public_id: string, body: unknown): Promise<UserSettingsOutput> {
    const parsed = validateUpdateUserSettings(body);
    const user = await this.userService.findUserRecordByPublicId(user_public_id);
    if (!user) throw new NotFoundError('User');
    const result = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(user_public_id),
      () => this.repository.upsert(user.id, omitUndefined(parsed)),
    );
    return serializeUserSettings(result);
  }
}
