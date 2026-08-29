/**
 * Metadata keys whose values are internal numeric surrogate ids today
 * (sec-U2). Stripped from the admin audit-list response so internal bigints
 * never leak through arbitrary event payloads. Add new keys here when a
 * writer persists another raw internal id under a fresh name.
 *
 * Public-id keys (`session_public_id`, `role_public_id`, etc.) are
 * intentionally NOT on this list — admins need them to pivot from an audit
 * row to the resource it touched, and public ids are already returned via
 * the row's top-level columns.
 */
const SENSITIVE_INTERNAL_METADATA_KEYS = new Set<string>(['auth_method_id', 'mfa_method_id']);

/**
 * Defense-in-depth (sec): keys whose VALUE would be a credential/secret if a writer ever
 * placed one in the free-form `metadata` jsonb. Writers should never log secrets, but a
 * single careless `metadata: { token }` would otherwise persist and surface verbatim in the
 * admin / organization-audit feed. We keep the key (so an admin sees a field existed) and redact the
 * value before it leaves through the response. Matched case-insensitively as a substring.
 */
const SECRET_METADATA_KEY_PATTERN =
  /password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|access[_-]?key/i;
const REDACTED_METADATA_VALUE = '[REDACTED]';

/**
 * Public-id keys (`*_public_id`) are safe forensic identifiers admins pivot on — never redact
 * them even when the name brushes the secret pattern (e.g. `api_key_public_id`).
 */
function isPublicIdMetadataKey(key: string): boolean {
  return key.endsWith('public_id');
}

function sanitizeMetadata(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return metadata;
  }

  const sanitizedEntries = Object.entries(metadata as Record<string, unknown>)
    .filter(([key]) => !SENSITIVE_INTERNAL_METADATA_KEYS.has(key))
    .map(([key, value]): [string, unknown] =>
      !isPublicIdMetadataKey(key) && SECRET_METADATA_KEY_PATTERN.test(key)
        ? [key, REDACTED_METADATA_VALUE]
        : [key, value],
    );
  return Object.fromEntries(sanitizedEntries);
}

/**
 * Audit log row fields the serializer reads. Mirrors the live Drizzle row but only includes
 * the columns we either expose (after resolution / passthrough) or use to look up a public id
 * (`actor_user_id`, `target_user_id`, `organization_id`). Every column NOT in this list is
 * automatically dropped from the response — see `serializeOne`.
 */
interface AuditLogRow {
  // Internal ids used to resolve public ids — dropped from the response.
  actor_user_id?: number | null;
  target_user_id?: number | null;
  organization_id?: number | null;

  // Allowlist fields surfaced verbatim.
  action: string;
  resource_type: string;
  ip_address?: string | null;
  user_agent?: string | null;
  severity: string;
  metadata?: unknown;
  created_at: Date | string;
}

/**
 * Batch-resolved internal-id → public-id maps that the caller (audit service) builds via the
 * `auth.resolve_user_public_ids_by_ids` SECURITY DEFINER resolver and a join on
 * `tenancy.organizations`. Passed to {@link AuditSerializer.many} so the serializer can stay a
 * pure function while still surfacing the public ids admins need for forensic pivots.
 */
export interface AuditLogPublicIdResolution {
  /** internal user id → public id (covers both actor and target). */
  userPublicIds: ReadonlyMap<number, string>;
  /** internal organization id → public id. */
  organizationPublicIds: ReadonlyMap<number, string>;
}

const EMPTY_RESOLUTION: AuditLogPublicIdResolution = {
  userPublicIds: new Map(),
  organizationPublicIds: new Map(),
};

function toIsoString(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function serializeOne<T extends AuditLogRow>(row: T, resolution: AuditLogPublicIdResolution) {
  // sec-re-08: strip-only allowlist mirroring sec-T #17. The prior implementation
  // spread the entire Drizzle row through with `...item`, leaking the bigserial `id`,
  // every `*_user_id`/`organization_id`/`resource_id`/`actor_api_key_id` bigint, and
  // the internal `metadata.{auth_method_id,mfa_method_id}` keys back to the
  // admin / organization-audit clients. Promoting `metadata` sanitisation while spreading
  // top-level bigints was internally incoherent (an admin's response strip
  // protected the metadata keys but leaked `target_user_id` directly — a more
  // useful enumeration vector for the same class).
  //
  // We DROP every internal numeric id and surface the resolved public id where
  // we have one. `actor_api_key_id` / `resource_id` are intentionally not
  // resolved here — admins correlate via `metadata` (which already carries
  // public ids the writer captured) and `resource_type`; surfacing the bigint
  // would just re-open the leak.
  const actorInternalId = row.actor_user_id ?? null;
  const targetInternalId = row.target_user_id ?? null;
  const organizationInternalId = row.organization_id ?? null;
  return {
    actor_user_id:
      actorInternalId !== null ? (resolution.userPublicIds.get(actorInternalId) ?? null) : null,
    target_user_id:
      targetInternalId !== null ? (resolution.userPublicIds.get(targetInternalId) ?? null) : null,
    organization_id:
      organizationInternalId !== null
        ? (resolution.organizationPublicIds.get(organizationInternalId) ?? null)
        : null,
    action: row.action,
    resource_type: row.resource_type,
    ip_address: row.ip_address ?? null,
    user_agent: row.user_agent ?? null,
    severity: row.severity,
    metadata: sanitizeMetadata(row.metadata),
    created_at: toIsoString(row.created_at),
  };
}

/**
 * Strip-only response serializer for `audit.logs` rows (sec-re-08). Mirrors the sec-T #17
 * `SubscriptionSerializer` shape: a typed allowlist that drops every internal bigint id and
 * surfaces the caller-resolved public ids in their place.
 *
 * @remarks
 * The caller (audit service) is responsible for batch-resolving
 * `actor_user_id` / `target_user_id` via the `auth.resolve_user_public_ids_by_ids` SECURITY
 * DEFINER function (auth.users is FORCE RLS — a plain join from the audit context returns
 * zero rows) and `organization_id` via a join on `tenancy.organizations`. The serializer
 * itself is a pure function so it can be unit-tested without touching the database.
 *
 * When no resolution is supplied (or a particular id is missing from the map), the serializer
 * emits `null` for that public id. This keeps the response contract stable for the
 * legacy admin path until the resolver is wired through — better to surface `null` than to
 * accidentally regress the sec-re-08 strip with a partial map.
 */
export const AuditSerializer = {
  many<T extends AuditLogRow>(
    items: T[],
    resolution: AuditLogPublicIdResolution = EMPTY_RESOLUTION,
  ) {
    return items.map((item) => serializeOne(item, resolution));
  },
};
