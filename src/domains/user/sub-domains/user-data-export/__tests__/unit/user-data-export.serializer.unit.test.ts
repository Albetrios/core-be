import { describe, expect, it } from 'vitest';
import { serializeUserDataExport } from '@/domains/user/sub-domains/user-data-export/user-data-export.serializer.js';
import type { UserDataExportRow } from '@/domains/user/sub-domains/user-data-export/user-data-export.types.js';

function makeExportRow(overrides: Partial<UserDataExportRow> = {}): UserDataExportRow {
  return {
    id: 1,
    public_id: 'export_pub_id_001',
    user_id: 100,
    status: 'completed',
    s3_key: 'exports/user-100/export_pub_id_001.json.gz',
    expires_at: new Date('2025-07-01T00:00:00.000Z'),
    completed_at: new Date('2025-06-01T10:00:00.000Z'),
    failed_at: null,
    error_code: null,
    created_at: new Date('2025-06-01T09:00:00.000Z'),
    updated_at: new Date('2025-06-01T10:00:00.000Z'),
    ...overrides,
  };
}

describe('serializeUserDataExport', () => {
  it('maps all fields to the correct output shape when fully populated', () => {
    const row = makeExportRow();
    const result = serializeUserDataExport(row, {
      download_url: 'https://s3.example.com/presigned',
    });
    expect(result).toEqual({
      id: 'export_pub_id_001',
      status: 'completed',
      download_url: 'https://s3.example.com/presigned',
      expires_at: '2025-07-01T00:00:00.000Z',
      completed_at: '2025-06-01T10:00:00.000Z',
      failed_at: null,
      error_code: null,
      created_at: '2025-06-01T09:00:00.000Z',
    });
  });

  it('includes download_url in the output when provided', () => {
    const result = serializeUserDataExport(makeExportRow(), {
      download_url: 'https://s3.example.com/file',
    });
    expect(result.download_url).toBe('https://s3.example.com/file');
  });

  it('serializes expires_at Date to ISO-8601 string', () => {
    const expiresAt = new Date('2025-09-15T00:00:00.000Z');
    const result = serializeUserDataExport(makeExportRow({ expires_at: expiresAt }));
    expect(result.expires_at).toBe('2025-09-15T00:00:00.000Z');
  });

  it('serializes completed_at Date to ISO-8601 string', () => {
    const completedAt = new Date('2025-06-10T08:30:00.000Z');
    const result = serializeUserDataExport(makeExportRow({ completed_at: completedAt }));
    expect(result.completed_at).toBe('2025-06-10T08:30:00.000Z');
  });

  it('sets download_url to null when not provided in options', () => {
    const result = serializeUserDataExport(makeExportRow());
    expect(result.download_url).toBeNull();
  });

  it('sets download_url to null when explicitly passed as null', () => {
    const result = serializeUserDataExport(makeExportRow(), { download_url: null });
    expect(result.download_url).toBeNull();
  });

  it('sets expires_at to null when row expires_at is null', () => {
    const result = serializeUserDataExport(makeExportRow({ expires_at: null }));
    expect(result.expires_at).toBeNull();
  });

  it('sets completed_at to null when row completed_at is null', () => {
    const result = serializeUserDataExport(makeExportRow({ completed_at: null }));
    expect(result.completed_at).toBeNull();
  });

  it('sets failed_at to null when row failed_at is null', () => {
    const result = serializeUserDataExport(makeExportRow({ failed_at: null }));
    expect(result.failed_at).toBeNull();
  });

  it('does not crash when all optional date fields are null simultaneously', () => {
    const row = makeExportRow({
      expires_at: null,
      completed_at: null,
      failed_at: null,
      error_code: null,
    });
    const result = serializeUserDataExport(row);
    expect(result.expires_at).toBeNull();
    expect(result.completed_at).toBeNull();
    expect(result.failed_at).toBeNull();
    expect(result.error_code).toBeNull();
  });

  it('serializes failed_at Date to ISO-8601 string for a failed export', () => {
    const failedAt = new Date('2025-06-05T16:00:00.000Z');
    const result = serializeUserDataExport(
      makeExportRow({ status: 'failed', failed_at: failedAt, completed_at: null }),
    );
    expect(result.failed_at).toBe('2025-06-05T16:00:00.000Z');
    expect(result.status).toBe('failed');
  });

  it('uses public_id as id (not internal id)', () => {
    const result = serializeUserDataExport(makeExportRow({ id: 999, public_id: 'export_pub_xyz' }));
    expect(result.id).toBe('export_pub_xyz');
  });

  it('serializes created_at as ISO-8601 string', () => {
    const createdAt = new Date('2025-05-01T07:00:00.000Z');
    const result = serializeUserDataExport(makeExportRow({ created_at: createdAt }));
    expect(result.created_at).toBe('2025-05-01T07:00:00.000Z');
  });

  it('preserves error_code when present', () => {
    const result = serializeUserDataExport(
      makeExportRow({ status: 'failed', error_code: 'EXPORT_TOO_LARGE' }),
    );
    expect(result.error_code).toBe('EXPORT_TOO_LARGE');
  });
});
