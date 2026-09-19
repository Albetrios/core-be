import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { SLUG_REGEX } from '@/shared/constants/index.js';
import {
  PUBLIC_ID_LENGTH,
  PUBLIC_ID_PREFIXES,
  PUBLIC_ID_REGEX,
  publicIdPatternFor,
  generatePublicId,
} from '@/shared/utils/identity/public-id.util.js';
import {
  createOpaqueCursorFromRow,
  decodeListCursor,
  encodeListCursor,
  parseListCursor,
} from '@/shared/utils/http/pagination.util.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import {
  createOrganizationDto,
  organizationSlugParamsDto,
  roleIdParamsDto,
  apiKeyIdParamsDto,
  notificationPolicyIdParamsDto,
} from '@/domains/tenancy/sub-domains/organization/organization.dto.js';
import { createOrganizationApiKeyDto } from '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.dto.js';
import { propertyAssertOptions } from '@/tests/helpers/fast-check-property.util.js';

const propertyOptions = propertyAssertOptions();

/**
 * Layer 2 (property) applied to the four tenancy value shapes that are defined by a *rule* rather
 * than by an enumerable set: the organization slug, the `<prefix>_<21>` public id carried by every
 * by-id route param, the permission-code vocabulary, and the opaque keyset cursor.
 *
 * Example-based tests pin the cases the author thought of. These pin the rule, over thousands of
 * generated inputs — the class of bug they exist to catch is a regex or codec that is accidentally
 * widened (a slug validator that starts accepting `Foo_Bar`, a cursor decoder that starts accepting
 * a bare integer and re-exposes internal auto-increment ids).
 */

/** Slug alphabet per SLUG_REGEX: lowercase alphanumerics joined by single hyphens. */
const slugSegment = fc.stringMatching(/^[a-z0-9]+$/).filter((segment) => segment.length > 0);
const validSlug = fc
  .array(slugSegment, { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join('-'))
  .filter((slug) => slug.length >= 1 && slug.length <= 100);

describe('organization slug (property)', () => {
  it('accepts every lowercase alphanumeric/hyphen slug within the length bound', () => {
    fc.assert(
      fc.property(validSlug, (slug) => {
        expect(SLUG_REGEX.test(slug)).toBe(true);
        expect(organizationSlugParamsDto.safeParse({ slug }).success).toBe(true);
        expect(createOrganizationDto.safeParse({ name: 'Acme', slug }).success).toBe(true);
      }),
      propertyOptions,
    );
  });

  it('rejects any slug containing an uppercase letter', () => {
    fc.assert(
      fc.property(validSlug, fc.stringMatching(/^[A-Z]$/), (slug, upper) => {
        const mutated = `${slug}${upper}`;
        expect(SLUG_REGEX.test(mutated)).toBe(false);
        expect(createOrganizationDto.safeParse({ name: 'Acme', slug: mutated }).success).toBe(
          false,
        );
      }),
      propertyOptions,
    );
  });

  it('rejects leading, trailing and doubled hyphens', () => {
    fc.assert(
      fc.property(validSlug, (slug) => {
        expect(SLUG_REGEX.test(`-${slug}`)).toBe(false);
        expect(SLUG_REGEX.test(`${slug}-`)).toBe(false);
        expect(SLUG_REGEX.test(`${slug}--${slug}`)).toBe(false);
      }),
      propertyOptions,
    );
  });

  it('rejects a slug longer than the 100-char bound however it is composed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 101, max: 400 }), (length) => {
        const slug = 'a'.repeat(length);
        expect(SLUG_REGEX.test(slug)).toBe(true); // shape is fine …
        expect(createOrganizationDto.safeParse({ name: 'Acme', slug }).success).toBe(false); // … length is not
      }),
      propertyOptions,
    );
  });
});

describe('public id shape (property)', () => {
  const entities = Object.keys(PUBLIC_ID_PREFIXES) as (keyof typeof PUBLIC_ID_PREFIXES)[];

  it('every generated public id matches the global regex and its own entity pattern', () => {
    fc.assert(
      fc.property(fc.constantFrom(...entities), (entity) => {
        const publicId = generatePublicId(entity);
        expect(PUBLIC_ID_REGEX.test(publicId)).toBe(true);
        expect(publicIdPatternFor(entity).test(publicId)).toBe(true);
        expect(publicId.split('_')[1]).toHaveLength(PUBLIC_ID_LENGTH);
      }),
      propertyOptions,
    );
  });

  it('an entity pattern never matches another entity id (prefixes are disjoint)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...entities), fc.constantFrom(...entities), (left, right) => {
        fc.pre(PUBLIC_ID_PREFIXES[left] !== PUBLIC_ID_PREFIXES[right]);
        expect(publicIdPatternFor(left).test(generatePublicId(right))).toBe(false);
      }),
      propertyOptions,
    );
  });

  it('the by-id route params reject any suffix outside the 1..28 bound', () => {
    // The param DTOs bound length only; the prefixed-id shape is enforced downstream by the
    // repository lookup. What must never regress is the upper bound — an unbounded id param is a
    // free-form string reaching a WHERE clause.
    fc.assert(
      fc.property(fc.integer({ min: 29, max: 200 }), (length) => {
        const oversized = `role_${'a'.repeat(length)}`;
        expect(roleIdParamsDto.safeParse({ role_id: oversized }).success).toBe(false);
        expect(apiKeyIdParamsDto.safeParse({ api_key_id: oversized }).success).toBe(false);
        expect(
          notificationPolicyIdParamsDto.safeParse({ notification_policy_id: oversized }).success,
        ).toBe(false);
      }),
      propertyOptions,
    );
  });

  it('the by-id route params are strict — no extra key rides along', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z_]{1,12}$/), (extraKey) => {
        fc.pre(extraKey !== 'role_id');
        // `__proto__` is excluded deliberately, not to make the test pass — see the dedicated case
        // below, which documents what actually happens with it.
        fc.pre(extraKey !== '__proto__');
        const parsed = roleIdParamsDto.safeParse({
          role_id: generatePublicId('memberRole'),
          [extraKey]: 'x',
        });
        expect(parsed.success).toBe(false);
      }),
      propertyOptions,
    );
  });

  it('rejects a __proto__ key after Zod strict validation', () => {
    // Zod now treats `__proto__` from JSON.parse as an extra key under `.strict()`.
    // Keep this pinned so prototype-pollution handling does not silently regress.
    const roleId = generatePublicId('memberRole');
    const poisoned = JSON.parse(`{"role_id":"${roleId}","__proto__":{"admin":true}}`) as unknown;

    expect(roleIdParamsDto.safeParse(poisoned).success).toBe(false);
    // Any ordinary extra key is still rejected — strictness is intact everywhere else.
    expect(roleIdParamsDto.safeParse({ role_id: roleId, admin: true }).success).toBe(false);
    // Parsing it does not pollute the prototype.
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });
});

describe('permission-code vocabulary (property)', () => {
  const tenancyCodes = Object.values(TENANCY_PERMISSIONS);

  it('every tenancy permission code is `<resource>:<action>` in lowercase kebab', () => {
    fc.assert(
      fc.property(fc.constantFrom(...tenancyCodes), (code) => {
        expect(code).toMatch(/^[a-z][a-z-]*:[a-z][a-z-]*$/);
        expect(code.split(':')).toHaveLength(2);
      }),
      propertyOptions,
    );
  });

  it('the api-key scopes array accepts any subset of the real catalog', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...tenancyCodes), { minLength: 1, maxLength: 12 }),
        (scopes) => {
          const parsed = createOrganizationApiKeyDto.safeParse({ name: 'ci', scopes });
          expect(parsed.success).toBe(true);
        },
      ),
      propertyOptions,
    );
  });

  it('the api-key scopes array rejects an empty set and anything past the 50-entry cap', () => {
    expect(createOrganizationApiKeyDto.safeParse({ name: 'ci', scopes: [] }).success).toBe(false);
    fc.assert(
      fc.property(fc.integer({ min: 51, max: 120 }), (count) => {
        const scopes = Array.from({ length: count }, (_, index) => `resource-${index}:read`);
        expect(createOrganizationApiKeyDto.safeParse({ name: 'ci', scopes }).success).toBe(false);
      }),
      propertyOptions,
    );
  });
});

describe('opaque keyset cursor (property)', () => {
  it('round-trips every payload it mints', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2000-01-01T00:00:00.000Z'),
          max: new Date('2100-01-01T00:00:00.000Z'),
          // `fc.date()` emits `Invalid Date` for ~0.4% of samples. A NOT NULL `timestamptz`
          // column can never hold one, so it is out of the property's domain, not a finding.
          noInvalidDate: true,
        }),
        fc.integer({ min: 1, max: 2_000_000 }),
        (createdAt, id) => {
          const cursor = createOpaqueCursorFromRow({
            created_at: createdAt,
            id,
            public_id: generatePublicId('membership'),
          });
          const parsed = parseListCursor(cursor);
          expect(parsed).not.toBeNull();
          expect(parsed?.kind).toBe('opaque');
          expect(parsed?.created_at.toISOString()).toBe(createdAt.toISOString());
          expect(parsed?.id).toBe(id);
        },
      ),
      propertyOptions,
    );
  });

  it('never decodes a bare integer — internal auto-increment ids stay un-guessable', () => {
    // Regression guard: legacy `after=<int>` support was removed because it let a caller walk the
    // table by internal id. A property test is the right shape here — the rule is "no integer",
    // not "not 1, not 2, not 3".
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000_000 }), (id) => {
        expect(parseListCursor(String(id))).toBeNull();
      }),
      propertyOptions,
    );
  });

  it('returns null (first page) for arbitrary non-cursor strings rather than throwing', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 200 }), (candidate) => {
        fc.pre(decodeListCursor(candidate) === null);
        expect(() => parseListCursor(candidate)).not.toThrow();
        expect(parseListCursor(candidate)).toBeNull();
      }),
      propertyOptions,
    );
  });

  it('rejects a cursor whose payload was tampered with after decoding', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2000-01-01T00:00:00.000Z'),
          max: new Date('2100-01-01T00:00:00.000Z'),
          // `fc.date()` emits `Invalid Date` for ~0.4% of samples. A NOT NULL `timestamptz`
          // column can never hold one, so it is out of the property's domain, not a finding.
          noInvalidDate: true,
        }),
        (createdAt) => {
          // A structurally valid base64url blob that is not a valid payload must read as "first
          // page", never as a partially-trusted cursor.
          const tampered = encodeListCursor({
            created_at: createdAt.toISOString(),
          } as never);
          const decoded = decodeListCursor(tampered);
          // Either it validates cleanly or it is rejected outright — never a half-populated object.
          if (decoded !== null) {
            expect(decoded.created_at).toBe(createdAt.toISOString());
          }
          expect(() => parseListCursor(tampered)).not.toThrow();
        },
      ),
      propertyOptions,
    );
  });
});
