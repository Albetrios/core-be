/**
 * Policy: every locale carries the same keys as English, with the same interpolation placeholders.
 *
 * `validate:locale-keys` already gates the code → JSON direction (a thrown key must exist). It does
 * not gate locale → locale. Two failure modes it cannot see:
 *
 * - a key added to `en` and forgotten elsewhere, so a Spanish caller receives English copy — or, if
 *   the fallback is missing, the raw `errors:someKey` string;
 * - a translated string that drops an interpolation placeholder, so the user reads a literal
 *   `{{organizationName}}` in an email or an error detail.
 *
 * Both are silent. Neither shows up in a test that asserts one locale at a time.
 *
 * The reference locale is English (`REFERENCE_LOCALE`), matching the repo's rule that new keys land
 * in `en` first. The scan is directory-driven, so a third locale is covered the day it is added.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const LOCALES_ROOT = join(process.cwd(), 'src/shared/locales');
const REFERENCE_LOCALE = 'en';

/**
 * Namespaces excluded from parity.
 *
 * `openapi` is documentation copy generated per locale by `docs:generate:multilang`; it is allowed
 * to diverge in structure and is gated by the be-openapi-multilingual workflow instead.
 */
const EXCLUDED_NAMESPACES = new Set(['openapi']);

const PLACEHOLDER_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g;

type FlatMessages = Record<string, string>;

function flatten(value: Record<string, unknown>, prefix = ''): FlatMessages {
  const flat: FlatMessages = {};
  for (const [key, nested] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof nested === 'string') {
      flat[path] = nested;
    } else if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      Object.assign(flat, flatten(nested as Record<string, unknown>, path));
    }
  }
  return flat;
}

function listLocales(): string[] {
  return readdirSync(LOCALES_ROOT)
    .filter((entry) => statSync(join(LOCALES_ROOT, entry)).isDirectory())
    .sort();
}

function listNamespaces(locale: string): string[] {
  return readdirSync(join(LOCALES_ROOT, locale))
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.replace(/\.json$/, ''))
    .filter((namespace) => !EXCLUDED_NAMESPACES.has(namespace))
    .sort();
}

function loadMessages(locale: string, namespace: string): FlatMessages {
  const path = join(LOCALES_ROOT, locale, `${namespace}.json`);
  return flatten(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>);
}

function placeholdersIn(message: string): Set<string> {
  return new Set(
    [...message.matchAll(PLACEHOLDER_PATTERN)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined),
  );
}

describe('locale parity', () => {
  const locales = listLocales();
  const otherLocales = locales.filter((locale) => locale !== REFERENCE_LOCALE);
  const referenceNamespaces = listNamespaces(REFERENCE_LOCALE);

  it(`finds the ${REFERENCE_LOCALE} reference locale and at least one translation`, () => {
    expect(locales).toContain(REFERENCE_LOCALE);
    expect(otherLocales.length).toBeGreaterThan(0);
    expect(referenceNamespaces.length).toBeGreaterThan(0);
  });

  it('every locale defines the same namespaces as the reference', () => {
    const offenders = otherLocales.flatMap((locale) => {
      const namespaces = listNamespaces(locale);
      const missing = referenceNamespaces.filter((namespace) => !namespaces.includes(namespace));
      const extra = namespaces.filter((namespace) => !referenceNamespaces.includes(namespace));
      return [
        ...missing.map((namespace) => `${locale}: missing namespace "${namespace}"`),
        ...extra.map(
          (namespace) => `${locale}: has "${namespace}" which ${REFERENCE_LOCALE} lacks`,
        ),
      ];
    });

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('every locale defines every reference key', () => {
    const offenders: string[] = [];

    for (const namespace of referenceNamespaces) {
      const reference = loadMessages(REFERENCE_LOCALE, namespace);
      for (const locale of otherLocales) {
        if (!listNamespaces(locale).includes(namespace)) continue;
        const translated = loadMessages(locale, namespace);
        for (const key of Object.keys(reference)) {
          if (!(key in translated)) {
            offenders.push(`${locale}/${namespace}.json is missing "${key}"`);
          }
        }
      }
    }

    expect(
      offenders,
      `Untranslated keys fall back to English at best, and leak a raw key at worst:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('no locale defines a key the reference does not have', () => {
    const offenders: string[] = [];

    for (const namespace of referenceNamespaces) {
      const reference = loadMessages(REFERENCE_LOCALE, namespace);
      for (const locale of otherLocales) {
        if (!listNamespaces(locale).includes(namespace)) continue;
        for (const key of Object.keys(loadMessages(locale, namespace))) {
          if (!(key in reference)) {
            offenders.push(`${locale}/${namespace}.json has orphan key "${key}"`);
          }
        }
      }
    }

    expect(
      offenders,
      `Orphan keys are dead copy — a rename in ${REFERENCE_LOCALE} left them behind:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('every translated message carries the same interpolation placeholders as the reference', () => {
    const offenders: string[] = [];

    for (const namespace of referenceNamespaces) {
      const reference = loadMessages(REFERENCE_LOCALE, namespace);
      for (const locale of otherLocales) {
        if (!listNamespaces(locale).includes(namespace)) continue;
        const translated = loadMessages(locale, namespace);

        for (const [key, referenceMessage] of Object.entries(reference)) {
          const translatedMessage = translated[key];
          if (translatedMessage === undefined) continue;

          const expected = placeholdersIn(referenceMessage);
          const actual = placeholdersIn(translatedMessage);

          const dropped = [...expected].filter((name) => !actual.has(name));
          const invented = [...actual].filter((name) => !expected.has(name));

          if (dropped.length > 0) {
            offenders.push(
              `${locale}/${namespace}.json "${key}" drops {{${dropped.join('}}, {{')}}} — ` +
                'the value never reaches the user',
            );
          }
          if (invented.length > 0) {
            offenders.push(
              `${locale}/${namespace}.json "${key}" adds {{${invented.join('}}, {{')}}} — ` +
                'nothing supplies it, so it renders literally',
            );
          }
        }
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
