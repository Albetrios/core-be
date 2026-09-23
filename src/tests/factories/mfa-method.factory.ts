import { database } from '@/infrastructure/database/connection.js';
import { mfa_methods } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa-method.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

export interface CreateMfaMethodOptions {
  userId: number;
  methodType?: string;
  isVerified?: boolean;
  isPrimary?: boolean;
}

/**
 * Create a test MFA method owned by `userId` (auth.mfa_methods).
 */
export async function createTestMfaMethod(options: CreateMfaMethodOptions) {
  const publicId = generatePublicId('authMethod');
  const [method] = await database
    .insert(mfa_methods)
    .values({
      public_id: publicId,
      user_id: options.userId,
      method_type: options.methodType ?? 'TOTP',
      is_verified: options.isVerified ?? true,
      is_primary: options.isPrimary ?? false,
    })
    .returning();
  return method!;
}
