import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const DOMAINS_ROOT = join(ROOT, 'src/domains');

/**
 * Database context wrappers that pin a pooled Postgres checkout for the callback
 * duration (production-readiness finding #5).
 */
const DATABASE_CONTEXT_WRAPPERS = [
  'withPrincipalDatabaseContext',
  'withSessionDatabaseContext',
  'withMaintenanceDatabaseContext',
  'withTransaction',
] as const;

/**
 * Outbound network / external SDK calls that must not run inside a DB context
 * callback — they would hold a checkout across remote round trips.
 */
const OUTBOUND_IN_CONTEXT_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bfetch\s*\(/, label: 'fetch(' },
  { pattern: /\bfetchWebhook\w*\s*\(/, label: 'fetchWebhook*(' },
  { pattern: /\bthis\.objectStorage\.\w+\s*\(/, label: 'this.objectStorage.*(' },
  { pattern: /\bthis\.paymentProvider\.\w+\s*\(/, label: 'this.paymentProvider.*(' },
  { pattern: /\bverifyTurnstileToken\s*\(/, label: 'verifyTurnstileToken(' },
  { pattern: /\bsendEmail\s*\(/, label: 'sendEmail(' },
];

const SCAN_SKIP_PATH_SEGMENTS = ['__tests__', 'workers', 'processors', 'queues', 'events'] as const;

function collectDomainSourceFiles(directory: string, files: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    const relativePath = relative(ROOT, fullPath);
    if (SCAN_SKIP_PATH_SEGMENTS.some((segment) => relativePath.split('/').includes(segment))) {
      continue;
    }
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      collectDomainSourceFiles(fullPath, files);
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.includes('.test.')) {
      files.push(relativePath);
    }
  }
  return files;
}

function findCallbackBodyStart(
  content: string,
  wrapperIndex: number,
  needle: string,
): number | null {
  let index = wrapperIndex + needle.length;
  let parenthesesDepth = 0;

  for (; index < content.length; index += 1) {
    const character = content[index];
    if (character === '(') {
      parenthesesDepth += 1;
    } else if (character === ')') {
      parenthesesDepth -= 1;
      if (parenthesesDepth < 0) {
        return null;
      }
    } else if (character === '{' && parenthesesDepth === 0) {
      return index;
    }
  }

  return null;
}

function readBalancedBraces(content: string, openBraceIndex: number): string | null {
  let braceDepth = 0;
  let body = '';

  for (let index = openBraceIndex; index < content.length; index += 1) {
    const character = content[index];
    body += character;
    if (character === '{') {
      braceDepth += 1;
    } else if (character === '}') {
      braceDepth -= 1;
      if (braceDepth === 0) {
        return body;
      }
    }
  }

  return null;
}

function extractCallbackBodies(content: string, wrapperName: string): string[] {
  const bodies: string[] = [];
  const needle = `${wrapperName}(`;
  let searchIndex = 0;

  while (searchIndex < content.length) {
    const wrapperIndex = content.indexOf(needle, searchIndex);
    if (wrapperIndex === -1) {
      break;
    }

    const openBraceIndex = findCallbackBodyStart(content, wrapperIndex, needle);
    if (openBraceIndex !== null) {
      const body = readBalancedBraces(content, openBraceIndex);
      if (body !== null) {
        bodies.push(body);
      }
    }

    searchIndex = wrapperIndex + needle.length;
  }

  return bodies;
}

function findViolations(content: string, relativePath: string): string[] {
  const violations: string[] = [];

  for (const wrapperName of DATABASE_CONTEXT_WRAPPERS) {
    for (const body of extractCallbackBodies(content, wrapperName)) {
      const lines = body.split('\n');
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const trimmedLine = (lines[lineIndex] ?? '').trim();
        if (
          trimmedLine.length === 0 ||
          trimmedLine.startsWith('//') ||
          trimmedLine.startsWith('*') ||
          trimmedLine.startsWith('/*')
        ) {
          continue;
        }
        for (const { pattern, label } of OUTBOUND_IN_CONTEXT_PATTERNS) {
          if (pattern.test(trimmedLine)) {
            violations.push(`${relativePath}: ${wrapperName} callback → ${label}`);
          }
        }
      }
    }
  }

  return violations;
}

describe('RLS database context network isolation (production-readiness finding #5)', () => {
  it('should forbid outbound network calls inside database context callbacks in domain code', () => {
    const allViolations: string[] = [];

    for (const relativePath of collectDomainSourceFiles(DOMAINS_ROOT)) {
      const content = readFileSync(join(ROOT, relativePath), 'utf-8');
      allViolations.push(...findViolations(content, relativePath));
    }

    expect(allViolations).toEqual([]);
  });
});
