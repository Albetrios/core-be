import { describe, it, expect, afterEach } from 'vitest';
import {
  buildPublicMediaUrl,
  isPublicMediaKey,
} from '@/infrastructure/storage/public-media-url.util.js';
import { resetEnvCacheForTests } from '@/shared/config/env.config.js';

/**
 * audit-#13: public media (avatars, organization logos) must be servable while the S3 bucket keeps
 * "Block all public access" on. `getObjectUrl`/`buildPublicMediaUrl` (1) refuse non-public keys so a
 * private object can never be handed out as a public link, and (2) prefer PUBLIC_MEDIA_BASE_URL (a
 * distribution scoped to public prefixes) over the raw S3 URL when configured.
 */
describe('buildPublicMediaUrl (audit-#13)', () => {
  const originalBase = process.env.PUBLIC_MEDIA_BASE_URL;

  afterEach(() => {
    if (originalBase === undefined) delete process.env.PUBLIC_MEDIA_BASE_URL;
    else process.env.PUBLIC_MEDIA_BASE_URL = originalBase;
    resetEnvCacheForTests();
  });

  it('classifies public-media vs private keys', () => {
    expect(isPublicMediaKey('avatars/u1/a.png')).toBe(true);
    expect(isPublicMediaKey('organization-logos/o1/l.png')).toBe(true);
    expect(isPublicMediaKey('user-files/u1/secret.pdf')).toBe(false);
    expect(isPublicMediaKey('organization-files/o1/contract.pdf')).toBe(false);
  });

  it('refuses to build a public URL for a private key (avatars/organization-logos only)', () => {
    delete process.env.PUBLIC_MEDIA_BASE_URL;
    resetEnvCacheForTests();
    expect(() =>
      buildPublicMediaUrl('user-files/u1/secret.pdf', { bucket: 'b', region: 'us-east-1' }),
    ).toThrow(/non-public/);
    expect(() =>
      buildPublicMediaUrl('organization-files/o1/contract.pdf', {
        bucket: 'b',
        region: 'us-east-1',
      }),
    ).toThrow(/non-public/);
  });

  it('falls back to the virtual-hosted S3 URL when PUBLIC_MEDIA_BASE_URL is unset', () => {
    delete process.env.PUBLIC_MEDIA_BASE_URL;
    resetEnvCacheForTests();
    expect(
      buildPublicMediaUrl('organization-logos/o1/logo.png', {
        bucket: 'my-bucket',
        region: 'eu-west-1',
      }),
    ).toBe('https://my-bucket.s3.eu-west-1.amazonaws.com/organization-logos/o1/logo.png');
  });

  it('builds from PUBLIC_MEDIA_BASE_URL (distribution) when set, so the bucket can stay private', () => {
    process.env.PUBLIC_MEDIA_BASE_URL = 'https://cdn.example.com';
    resetEnvCacheForTests();
    expect(
      buildPublicMediaUrl('avatars/u1/a.png', { bucket: 'my-bucket', region: 'eu-west-1' }),
    ).toBe('https://cdn.example.com/avatars/u1/a.png');
  });
});
