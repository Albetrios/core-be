import { createHash } from 'node:crypto';
import { faker } from '@faker-js/faker';
import { database } from '@/infrastructure/database/connection.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { users } from '@/domains/user/user.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

export interface CreateUserOptions {
  email?: string;
  firstName?: string;
  lastName?: string;
  status?: string;
  /** Provide a pre-hashed password (Argon2id). */
  passwordHash?: string;
  isEmailVerified?: boolean;
}

/**
 * Create a test user in the database.
 */
export async function createTestUser(options: CreateUserOptions = {}) {
  const publicId = generatePublicId('user');
  const email = options.email ?? faker.internet.email().toLowerCase();
  const emailHash = createHash('sha256').update(email).digest('hex');

  // `auth.users` is FORCE RLS and its WITH CHECK demands the new row's `public_id` match
  // `app.current_user_public_id`. The application satisfies that by minting the id FIRST and
  // inserting inside a context pinned to it (`UserService.createFromOAuth`); this fixture does
  // the same, so it creates users the way production does rather than by out-privileging the
  // policy. Without it the insert is rejected the moment the pool under test is RLS-subject —
  // which is every run of `pnpm test:rls-role`.
  const [user] = await withAppDatabaseContext(
    PRINCIPAL_SCOPE.VERIFIED({ userPublicId: publicId }),
    (databaseHandle) =>
      (databaseHandle ?? database)
        .insert(users)
        .values({
          public_id: publicId,
          email,
          email_hash: emailHash,
          first_name: options.firstName ?? faker.person.firstName(),
          last_name: options.lastName ?? faker.person.lastName(),
          status: options.status ?? 'ACTIVE',
          password_hash: options.passwordHash ?? null,
          is_email_verified: options.isEmailVerified ?? false,
        })
        .returning(),
  );

  return user!;
}

/**
 * Create a test user with a known password for login tests.
 * Returns the user and the plaintext password.
 */
export async function createTestUserWithPassword(
  options: Omit<CreateUserOptions, 'passwordHash'> & { password?: string } = {},
) {
  const { hashPassword } = await import('@/shared/utils/security/password.util.js');
  const plainPassword = options.password ?? 'TestPassword123!';
  const passwordHash = await hashPassword(plainPassword);
  const user = await createTestUser({ ...options, passwordHash });
  return { user, password: plainPassword };
}
