import { database } from '@/infrastructure/database/connection.js';
import {
  runWithPinnedDatabaseHandle,
  setLocalDatabaseConfig,
  type RequestScopedPostgresDatabase,
} from '@/infrastructure/database/contexts/request-database.context.js';
import { ConfigurationError } from '@/shared/errors/index.js';

/**
 * THE registry of pre-auth session database contexts — the single source of
 * truth for the session-artifact GUCs: each kind names the `app.*` GUC that
 * lets RLS resolve exactly one `auth.sessions` row by that artifact.
 *
 * @remarks
 * - **Notes:** session contexts run BEFORE a verified identity exists — the
 *   artifact (cookie session public id, or a token hash) IS the identity being
 *   verified, which is why this family is separate from the principal scope and
 *   must never gain user/organization kinds. The policy arm for
 *   `app.current_session_refresh_token_hash` exists in migrations but has no
 *   kind here because no code path sets it — add the row only together with a
 *   real minting call site (or drop the arm in a migration).
 */
export const SESSION_CONTEXTS = {
  public_id: { guc: 'app.current_session_public_id' },
  token_hash: { guc: 'app.current_session_token_hash' },
} as const satisfies Record<string, { readonly guc: string }>;

/** Derived — the closed set of session-context kinds. */
export type SessionContextKind = keyof typeof SESSION_CONTEXTS;

declare const SESSION_SCOPE_BRAND: unique symbol;

/**
 * Unforgeable pre-auth session scope: which artifact kind identifies the
 * session, and the artifact value itself.
 *
 * @remarks
 * Minted only by {@link createSessionDatabaseScope}, whose importers are
 * confined to the auth domain by the session-context confinement policy test.
 */
export interface SessionDatabaseScope<K extends SessionContextKind = SessionContextKind> {
  readonly kind: K;
  readonly value: string;
  readonly [SESSION_SCOPE_BRAND]: true;
}

/**
 * Mints a {@link SessionDatabaseScope} from a session artifact — do NOT import
 * outside the auth domain (pinned by the confinement policy test).
 *
 * @remarks
 * - **Failure modes:** throws {@link ConfigurationError} for an empty artifact
 *   value — an empty GUC would silently match no session row.
 * - **Side effects:** none.
 */
export function createSessionDatabaseScope<K extends SessionContextKind>(
  kind: K,
  value: string,
): SessionDatabaseScope<K> {
  if (value.length === 0) {
    throw new ConfigurationError('SessionDatabaseScope requires a non-empty artifact value.');
  }
  return { kind, value } as SessionDatabaseScope<K>;
}

/**
 * The single wrapper for pre-auth session database contexts: opens one
 * transaction, sets the scope's session-artifact GUC, pins the handle in ALS,
 * and releases everything at COMMIT/ROLLBACK.
 *
 * @remarks
 * - **Algorithm:** dispatches on `scope.kind` through {@link SESSION_CONTEXTS};
 *   RLS then admits exactly the one `auth.sessions` row matching the artifact.
 * - **Failure modes:** callback errors roll the transaction back; the GUC dies
 *   with the transaction.
 * - **Side effects:** one Postgres transaction per call; HTTP statement/lock
 *   timeouts stay (these are request-path flows).
 */
export async function withSessionDatabaseContext<T>(
  scope: SessionDatabaseScope,
  callback: (databaseHandle: RequestScopedPostgresDatabase) => Promise<T>,
): Promise<T> {
  const definition = SESSION_CONTEXTS[scope.kind];
  return database.transaction(async (transaction) => {
    const databaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
    await setLocalDatabaseConfig(databaseHandle, definition.guc, scope.value);
    return runWithPinnedDatabaseHandle(databaseHandle, () => callback(databaseHandle));
  });
}
