import { createHash, randomBytes } from 'node:crypto';
import { env } from '@/shared/config/env.config.js';
import { ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import {
  withPrincipalDatabaseContext,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/principal-database.context.js';
import type { OrganizationRepository } from '@/domains/tenancy/sub-domains/organization/organization.repository.js';
import type { OrganizationApiKeyRepository } from './organization-api-key.repository.js';
import type { AuthorizationService } from '@/domains/tenancy/sub-domains/permission/authorization.service.js';
import type { PermissionRepository } from '@/domains/tenancy/sub-domains/permission/permission.repository.js';
import { assertCallerCanGrantPermissionCodes } from '@/domains/tenancy/sub-domains/permission/assert-grantable-permissions.util.js';
import type {
  OrganizationApiKeyOutput,
  CreateOrganizationApiKeyResult,
  OrganizationApiKeyAuthMatch,
} from './organization-api-key.types.js';
import {
  validateCreateOrganizationApiKey,
  validateUpdateOrganizationApiKey,
  validateListOrganizationApiKeysQuery,
} from './organization-api-key.validator.js';
import { serializeOrganizationApiKey } from './organization-api-key.serializer.js';
import {
  ORGANIZATION_API_KEY_PREFIX_DISPLAY_LENGTH,
  ORGANIZATION_API_KEY_RAW_SECRET_BYTE_LENGTH,
} from '@/shared/constants/limits.constants.js';
import { resolveVerifiedOrganizationPrincipalScope } from '@/shared/utils/identity/verified-principal-scope.util.js';

function generateApiKey(): string {
  return `ak_${randomBytes(ORGANIZATION_API_KEY_RAW_SECRET_BYTE_LENGTH).toString('hex')}`;
}

function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

function getKeyPrefix(key: string): string {
  return key.slice(0, ORGANIZATION_API_KEY_PREFIX_DISPLAY_LENGTH);
}

/**
 * Lifecycle service for organization-scoped API keys (CRUD, rotate, and
 * authenticate-by-prefix).
 *
 * @remarks
 * - **Algorithm:** create generates `ak_<hex>` of
 *   `ORGANIZATION_API_KEY_RAW_SECRET_BYTE_LENGTH` random bytes, derives a
 *   SHA-256 hash and a fixed-length prefix; only the hash + prefix are
 *   persisted. Authentication looks up active candidates by prefix, then
 *   defers the equality check to the caller-supplied `hashCompare`
 *   (constant-time), filters expired keys, and touches `last_used_at` on a
 *   match. Rotation soft-deletes the existing key and creates a new one
 *   with the same name and scopes; a fresh raw secret is returned.
 * - **Failure modes:** `NotFoundError` for missing organization or API key;
 *   validation errors propagate from the DTO validators.
 * - **Side effects:** persistent row writes (`create`, `update`,
 *   `softDelete`, `touchLastUsedAt`); mutations are wrapped in
 *   `withOrganizationDatabaseContext` to satisfy RLS.
 * - **Notes:** raw secret is returned to the caller exactly once (creation
 *   and rotation responses); revocation = soft-delete or status flip to
 *   `REVOKED`; key prefix is non-secret and used purely as a lookup index.
 */
export class OrganizationApiKeyService {
  constructor(
    private readonly organizationRepository: OrganizationRepository,
    private readonly apiKeyRepository: OrganizationApiKeyRepository,
    private readonly authorizationService: AuthorizationService,
    private readonly permissionRepository: PermissionRepository,
  ) {}

  async list(scope: OrganizationPrincipalDatabaseScope, query: unknown) {
    const organization_public_id = scope.organizationPublicId;
    const parsed = validateListOrganizationApiKeysQuery(query);
    return withPrincipalDatabaseContext(scope, async () => {
      const organization = await this.organizationRepository.findByPublicId(organization_public_id);
      if (!organization) throw new NotFoundError('Organization');
      const result = await this.apiKeyRepository.findByOrganizationId(
        organization.id,
        omitUndefined({
          after: parsed.after,
          limit: parsed.limit,
          q: parsed.q,
          sort: parsed.sort,
          order: parsed.order,
        }),
      );
      return {
        ...result,
        items: result.items.map((row) => serializeOrganizationApiKey(row, organization_public_id)),
      };
    });
  }

  async getByPublicId(
    scope: OrganizationPrincipalDatabaseScope,
    api_key_public_id: string,
  ): Promise<OrganizationApiKeyOutput> {
    const organization_public_id = scope.organizationPublicId;
    return withPrincipalDatabaseContext(scope, async () => {
      const organization = await this.organizationRepository.findByPublicId(organization_public_id);
      if (!organization) throw new NotFoundError('Organization');
      const row = await this.apiKeyRepository.findByPublicId(api_key_public_id, organization.id);
      if (!row) throw new NotFoundError('API key');
      return serializeOrganizationApiKey(row, organization_public_id);
    });
  }

  async create(
    scope: OrganizationPrincipalDatabaseScope,
    body: unknown,
    created_by_user_public_id: string,
    options?: { expiresAtOverride?: Date | null },
  ): Promise<CreateOrganizationApiKeyResult> {
    const organization_public_id = scope.organizationPublicId;
    const parsed = validateCreateOrganizationApiKey(body);
    await assertCallerCanGrantPermissionCodes({
      authorizationService: this.authorizationService,
      permissionRepository: this.permissionRepository,
      callerUserPublicId: created_by_user_public_id,
      organizationPublicId: organization_public_id,
      requestedPermissionCodes: parsed.scopes,
    });
    return withPrincipalDatabaseContext(scope, async () => {
      const organization = await this.organizationRepository.findByPublicId(organization_public_id);
      if (!organization) throw new NotFoundError('Organization');
      // sec-r5-followup-ratelimit-dos-1 + audit-#8: serialize the per-org count + insert with a
      // transaction-scoped advisory lock so concurrent creates cannot both pass the same count
      // and overshoot ORGANIZATION_API_KEY_MAX_PER_ORG. The lock auto-releases at commit.
      await this.apiKeyRepository.acquireCreationQuotaLock(organization.id);
      const activeCount = await this.apiKeyRepository.countActiveByOrganization(organization.id);
      if (activeCount >= env.ORGANIZATION_API_KEY_MAX_PER_ORG) {
        throw new ConflictError('errors:organizationApiKeyMaxReached', {
          max: env.ORGANIZATION_API_KEY_MAX_PER_ORG,
        });
      }
      const userId =
        await this.organizationRepository.resolveUserIdByPublicId(created_by_user_public_id);
      const rawKey = generateApiKey();
      const keyHash = hashApiKey(rawKey);
      const keyPrefix = getKeyPrefix(rawKey);
      // Rotation passes the replaced key's absolute expiry through `expiresAtOverride` (which may be
      // null = no expiry) so a time-boxed key does not silently become non-expiring on rotate. A
      // normal create resolves the expiry from the request's `expires_in_days` instead.
      let expiresAt: Date | null;
      if (options?.expiresAtOverride !== undefined) {
        expiresAt = options.expiresAtOverride;
      } else if (parsed.expires_in_days) {
        expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + parsed.expires_in_days);
      } else {
        expiresAt = null;
      }
      const row = await this.apiKeyRepository.create({
        organization_id: organization.id,
        name: parsed.name,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        scopes: parsed.scopes,
        expires_at: expiresAt,
        created_by_user_id: userId,
      });
      const apiKey = serializeOrganizationApiKey(row, organization_public_id);
      return { api_key: apiKey, raw_key: rawKey };
    });
  }

  async update(
    scope: OrganizationPrincipalDatabaseScope,
    api_key_public_id: string,
    body: unknown,
    updated_by_user_public_id: string | undefined,
  ): Promise<OrganizationApiKeyOutput> {
    const organization_public_id = scope.organizationPublicId;
    const parsed = validateUpdateOrganizationApiKey(body);
    return withPrincipalDatabaseContext(scope, async () => {
      const organization = await this.organizationRepository.findByPublicId(organization_public_id);
      if (!organization) throw new NotFoundError('Organization');
      const row = await this.apiKeyRepository.findByPublicId(api_key_public_id, organization.id);
      if (!row) throw new NotFoundError('API key');
      const userId =
        await this.organizationRepository.resolveUserIdByPublicId(updated_by_user_public_id);
      const updated = await this.apiKeyRepository.update(
        api_key_public_id,
        organization.id,
        omitUndefined(parsed),
        userId ?? null,
      );
      if (!updated) throw new NotFoundError('API key');
      return serializeOrganizationApiKey(updated, organization_public_id);
    });
  }

  async delete(
    scope: OrganizationPrincipalDatabaseScope,
    api_key_public_id: string,
  ): Promise<void> {
    const organization_public_id = scope.organizationPublicId;
    return withPrincipalDatabaseContext(scope, async () => {
      const organization = await this.organizationRepository.findByPublicId(organization_public_id);
      if (!organization) throw new NotFoundError('Organization');
      const deleted = await this.apiKeyRepository.softDelete(api_key_public_id, organization.id);
      if (!deleted) throw new NotFoundError('API key');
    });
  }

  async authenticate(
    key_prefix: string,
    key_hash: string,
    hashCompare: (storedHash: string, candidateHash: string) => boolean,
  ): Promise<OrganizationApiKeyAuthMatch | null> {
    const candidates = await this.apiKeyRepository.findActiveByKeyPrefix(key_prefix);
    const now = new Date();
    for (const candidate of candidates) {
      if (!hashCompare(candidate.key_hash, key_hash)) continue;
      if (candidate.expires_at && candidate.expires_at <= now) continue;
      // The resolver already returned the owning organization public id (FORCE RLS on
      // tenancy.organizations means we cannot read it here without an org context). Establish that
      // context so the last_used_at touch passes the api_keys tenant-isolation policy.
      await withPrincipalDatabaseContext(
        resolveVerifiedOrganizationPrincipalScope(candidate.organization_public_id),
        () => this.apiKeyRepository.touchLastUsedAt(candidate.public_id),
      );
      return {
        public_id: candidate.public_id,
        organization_public_id: candidate.organization_public_id,
        scopes: candidate.scopes,
      };
    }
    return null;
  }

  async rotate(
    scope: OrganizationPrincipalDatabaseScope,
    api_key_public_id: string,
    created_by_user_public_id: string,
  ): Promise<CreateOrganizationApiKeyResult> {
    const organization_public_id = scope.organizationPublicId;
    return withPrincipalDatabaseContext(scope, async () => {
      const organization = await this.organizationRepository.findByPublicId(organization_public_id);
      if (!organization) throw new NotFoundError('Organization');
      const existing = await this.apiKeyRepository.findByPublicId(
        api_key_public_id,
        organization.id,
      );
      if (!existing) throw new NotFoundError('API key');
      // Atomic guard against a concurrent-rotation race: softDelete only retires a not-yet-deleted
      // key (WHERE deleted_at IS NULL) and returns null if another rotate/revoke already won. Only
      // the rotation that wins the retire mints the single replacement; the loser conflicts rather
      // than minting a duplicate replacement key.
      const retired = await this.apiKeyRepository.softDelete(api_key_public_id, organization.id);
      if (!retired) {
        throw new ConflictError('errors:apiKeyRotationConflict');
      }
      return this.create(
        scope,
        { name: existing.name, scopes: existing.scopes },
        created_by_user_public_id,
        // Carry the replaced key's expiry forward so rotation preserves the original time-box.
        { expiresAtOverride: existing.expires_at },
      );
    });
  }
}
