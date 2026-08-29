import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * route-#8 regression — the MCP `call_api` tool proxies an admin-authenticated sub-request and
 * must strip caller-supplied headers that could override authentication, session identity, or
 * tenant context. The set lives in a closure inside `mcp-server.ts` (dynamic-import gated behind
 * ENABLE_MCP_SERVER), so it is pinned textually: a future edit cannot silently drop a header from
 * BLOCKED_HEADERS without failing this test.
 */
describe('MCP call_api blocked headers policy (route-#8)', () => {
  const source = readFileSync(join(process.cwd(), 'src/infrastructure/mcp/mcp-server.ts'), 'utf8');
  const blockedBlock = source.match(/const BLOCKED_HEADERS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '';

  it('extracts the BLOCKED_HEADERS set', () => {
    expect(blockedBlock).not.toBe('');
  });

  it.each([
    'authorization',
    'cookie',
    'x-csrf-token',
    'x-forwarded-for',
    'x-real-ip',
    'x-organization-id', // removed from the API; stays blocked so MCP clients can never smuggle it back
  ])('blocks the %s header on the proxied sub-request', (header) => {
    expect(blockedBlock).toContain(`'${header}'`);
  });
});
