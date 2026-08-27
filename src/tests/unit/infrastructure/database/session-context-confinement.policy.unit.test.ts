import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Policy: session-artifact scopes are minted only inside the auth domain —
 * pre-auth session resolution IS the identity-verification step, so no other
 * layer may fabricate a session scope from an arbitrary value.
 */
const ALLOWED_PATH_FRAGMENTS = ['src/domains/auth/'];

describe('session-context confinement', () => {
  it('createSessionDatabaseScope is imported only from the auth domain (and tests)', () => {
    let output = '';
    try {
      output = execFileSync(
        'grep',
        ['-rl', 'createSessionDatabaseScope', 'src', '--include=*.ts'],
        {
          encoding: 'utf8',
        },
      );
    } catch {
      // no matches
    }

    const offenders = output
      .split('\n')
      .filter(Boolean)
      .filter((filePath) => !/\.test\.ts$/.test(filePath))
      .filter((filePath) => !filePath.includes('contexts/database-context.ts'))
      .filter(
        (filePath) => !ALLOWED_PATH_FRAGMENTS.some((fragment) => filePath.includes(fragment)),
      );

    expect(
      offenders,
      `createSessionDatabaseScope referenced outside the auth domain: ${offenders.join(', ')}.`,
    ).toEqual([]);
  });
});
