/**
 * A fresh `X-Idempotency-Key` for one write. The API takes 16–255 characters of letters, digits and
 * `. _ : ~ + / = -` — `k6-webhook-1-0` (14) was refused with 422 until the counters grew long enough.
 * The timestamp also keeps a key unique across runs: a rerun reusing one would replay the earlier
 * run's response for a resource that run already deleted.
 */
export function idempotencyKey(label) {
  // __ITER does not exist in setup() / teardown() (a ReferenceError there); the timestamp still keeps
  // those keys unique.
  const iteration = typeof __ITER === 'undefined' ? 'setup' : __ITER;
  return `k6-${label}-${__VU}-${iteration}-${Date.now()}`;
}
