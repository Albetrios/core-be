/**
 * User domain seed — create users for dev/demo.
 * Domain-owned; used by scripts/seed orchestration.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { users } from '@/domains/user/user.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { hashPassword } from '@/shared/utils/security/password.util.js';

/** Payload for {@link seedUser}; `password_hash` is optional so OAuth-style users can be seeded without credentials. */
export interface SeedUserPayload {
  email: string;
  first_name: string;
  last_name: string;
  job_title?: string | null;
  password_hash?: string | null;
  status?: string;
  /**
   * Stamp `onboarding_completed_at` so the frontend routes this user straight
   * to a dashboard instead of the onboarding wizard. Omit to leave the column
   * untouched (new rows default to NULL = wizard required on first login).
   */
  onboarding_completed_at?: Date;
}

/**
 * Insert a single user row for dev/demo seeding (`pnpm db:seed`, `pnpm db:seed:full`).
 * Sets `is_email_verified = true`, generates a fresh `public_id`, and computes the
 * lowercased SHA-256 `email_hash` so case-insensitive lookups work post-seed.
 * Idempotent: re-running updates `password_hash`, `first_name`, `last_name`, `job_title` on conflict.
 */
export async function seedUser(payload: SeedUserPayload) {
  const emailHash = createHash('sha256').update(payload.email.toLowerCase()).digest('hex');
  const [row] = await getRequestDatabase()
    .insert(users)
    .values({
      public_id: generatePublicId('user'),
      email: payload.email,
      email_hash: emailHash,
      is_email_verified: true,
      first_name: payload.first_name,
      last_name: payload.last_name,
      job_title: payload.job_title ?? null,
      password_hash: payload.password_hash ?? null,
      status: payload.status ?? 'ACTIVE',
      onboarding_completed_at: payload.onboarding_completed_at ?? null,
    })
    .onConflictDoUpdate({
      target: users.email,
      targetWhere: sql`${users.deleted_at} IS NULL`,
      set: {
        email_hash: emailHash,
        first_name: payload.first_name,
        last_name: payload.last_name,
        job_title: payload.job_title ?? null,
        password_hash: payload.password_hash ?? null,
        // Only stamp when the caller asked for it — an idempotent re-seed must
        // never NULL-out an existing user's onboarding progress.
        ...(payload.onboarding_completed_at
          ? { onboarding_completed_at: payload.onboarding_completed_at }
          : {}),
      },
    })
    .returning();
  return row ?? null;
}

/**
 * Seed a single demo user with known credentials for login.
 * Uses hashPassword so the user can log in via POST /api/v1/auth/login.
 * Stamps `onboarding_completed_at`: the demo admin exists to land on a working
 * dashboard, so the frontend must never route it through the onboarding wizard.
 */
export async function seedDemoUser(
  email: string,
  password: string,
  options?: { first_name?: string; last_name?: string },
) {
  const passwordHash = await hashPassword(password);
  return seedUser({
    email,
    first_name: options?.first_name ?? 'Demo',
    last_name: options?.last_name ?? 'User',
    password_hash: passwordHash,
    onboarding_completed_at: new Date(),
  });
}
