import { describe, expect, it } from 'vitest';
import { envSchema } from '@/shared/config/env-schema.js';
import { DEFAULT_ANTI_ENUMERATION_MINIMUM_DURATION_MS } from '@/shared/constants/security.constants.js';

const base = () => ({ ...process.env });

describe('AUTH_ANTI_ENUMERATION_MINIMUM_DURATION_MS production guard', () => {
  it('defaults to the hardened value when unset', () => {
    const r = envSchema.safeParse({ ...base(), NODE_ENV: 'local' });
    if (!r.success) throw new Error(JSON.stringify(r.error.issues.slice(0, 3)));
    expect(r.data.AUTH_ANTI_ENUMERATION_MINIMUM_DURATION_MS).toBe(
      DEFAULT_ANTI_ENUMERATION_MINIMUM_DURATION_MS,
    );
  });

  it('allows lowering it outside production', () => {
    const r = envSchema.safeParse({
      ...base(),
      NODE_ENV: 'local',
      AUTH_ANTI_ENUMERATION_MINIMUM_DURATION_MS: '0',
    });
    expect(r.success && r.data.AUTH_ANTI_ENUMERATION_MINIMUM_DURATION_MS).toBe(0);
  });

  it('REFUSES a value below the hardened floor in production', () => {
    const r = envSchema.safeParse({
      ...base(),
      NODE_ENV: 'production',
      AUTH_ANTI_ENUMERATION_MINIMUM_DURATION_MS: '10',
    });
    const hit =
      !r.success &&
      r.error.issues.some((i) => i.path[0] === 'AUTH_ANTI_ENUMERATION_MINIMUM_DURATION_MS');
    expect(hit).toBe(true);
  });

  it('permits RAISING it in production', () => {
    const r = envSchema.safeParse({
      ...base(),
      NODE_ENV: 'production',
      AUTH_ANTI_ENUMERATION_MINIMUM_DURATION_MS: '500',
    });
    const hit =
      !r.success &&
      r.error.issues.some((i) => i.path[0] === 'AUTH_ANTI_ENUMERATION_MINIMUM_DURATION_MS');
    expect(hit).toBe(false);
  });
});
