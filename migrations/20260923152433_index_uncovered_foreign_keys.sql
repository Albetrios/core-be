-- migration-transaction: none reason="CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction"
--
-- Index the last three foreign keys whose ON DELETE action had no index to use.
--
--   auth.sessions (organization_id)                      → tenancy.organizations  ON DELETE SET NULL
--   auth.user_notification_preferences (organization_id) → tenancy.organizations  ON DELETE SET NULL
--   auth.webauthn_credentials (user_id)                  → auth.users             ON DELETE CASCADE
--
-- Found by checking every foreign key in pg_constraint against pg_index: an FK is covered when its
-- columns lead a valid B-tree index that the FK's own `WHERE <column> = $1` can use — a full index,
-- or a partial one on `<column> IS NOT NULL`. These three were the only misses; the check is now a
-- standing gate (src/tests/integration/database/index-hygiene.integration.test.ts).
--
-- Why it matters: the daily tombstone jobs hard-delete organizations and users. For each deleted
-- parent row Postgres runs the FK action as `UPDATE/DELETE ... WHERE <column> = $1` on the child;
-- with no usable index that is a full scan of the child table PER DELETED ROW, and the purge holds
-- its locks for the duration. auth.sessions is one of the largest tables, so purging N
-- organizations cost N full scans of it.
--
-- - sessions / notification preferences: partial on `IS NOT NULL`, the same shape as the
--   attribution FK indexes in 20260623000000_attribution_fk_indexes.sql. On notification
--   preferences, chk_user_notif_prefs_no_org rejects a non-NULL organization_id on every insert
--   and update (it was added NOT VALID, so only rows older than the check can hold one): that
--   index stays near-empty, costs almost nothing to maintain, and turns the check into a probe.
--   20260606010000 dropped the old full index here as dead for reads — true, but the FK action
--   still needed it; the partial form keeps that migration's intent (no dead weight).
-- - webauthn_credentials: its only user_id index was partial on `revoked_at IS NULL`, which the
--   cascade (every passkey of the user, revoked or not) cannot use. It is replaced by a full
--   index, built FIRST so user_id is never unindexed. The full index also serves the active-passkey
--   reads: a user holds a handful of passkeys, so filtering `revoked_at IS NULL` on them is free.
--
-- CONCURRENTLY so writers are never blocked; IF [NOT] EXISTS so the file is idempotent, which a
-- non-transactional migration must be because there is no rollback if a statement fails.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_organization_id
  ON auth.sessions (organization_id)
  WHERE organization_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_notification_preferences_organization_id
  ON auth.user_notification_preferences (organization_id)
  WHERE organization_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webauthn_credentials_user_id
  ON auth.webauthn_credentials (user_id);
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS auth.webauthn_credentials_user_id_idx;
