import { describe, expect, it } from 'vitest';
import { buildStripeIdempotencyKey } from '@/domains/billing/sub-domains/subscription/subscription.service.js';

// audit #3: the client X-Idempotency-Key must be namespaced by organization before reaching Stripe's
// account-global idempotency space, so one tenant's chosen key cannot collide with another's.
describe('buildStripeIdempotencyKey (audit #3)', () => {
  it('returns undefined when no client key was supplied', () => {
    expect(buildStripeIdempotencyKey('sub-create', 'org_a', undefined)).toBeUndefined();
  });

  it('prefixes the key with operation + organization', () => {
    expect(buildStripeIdempotencyKey('sub-create', 'org_a', 'k1')).toBe('sub-create:org_a:k1');
  });

  it('disjoint key spaces: same client key from two organizations maps to different Stripe keys', () => {
    const a = buildStripeIdempotencyKey('sub-create', 'org_a', 'same-key');
    const b = buildStripeIdempotencyKey('sub-create', 'org_b', 'same-key');
    expect(a).not.toBe(b);
  });

  it('disjoint key spaces across operations within one org', () => {
    const create = buildStripeIdempotencyKey('sub-create', 'org_a', 'k');
    const cancel = buildStripeIdempotencyKey('sub-cancel', 'org_a', 'k');
    expect(create).not.toBe(cancel);
  });
});
