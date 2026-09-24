-- migration-transaction: none reason="DROP INDEX CONCURRENTLY cannot run inside a transaction"
--
-- Drop eight B-tree indexes that are strict prefixes of another index on the same table.
--
-- Each one was left behind when keyset pagination added a tie-breaker column: `(x, created_at)`
-- gained a sibling `(x, created_at, id)`, and the original was never retired. For a B-tree, an
-- index whose columns, sort options and collations are an exact leading prefix of a longer index
-- is redundant — the longer one serves every lookup, range and ordering the shorter one can.
-- Every pair below was checked on all of those, plus: same access method (so no btree/trigram
-- mix-ups), neither index unique, partial, or on an expression.
--
-- Dropped              ⊂  Kept
--   audit.idx_audit_logs_action_created          ⊂  idx_audit_logs_action_created_id
--   audit.idx_audit_logs_actor_created           ⊂  idx_audit_logs_actor_created_id
--   audit.idx_audit_logs_created_at              ⊂  idx_audit_logs_created_id
--   audit.idx_audit_logs_org_created             ⊂  idx_audit_logs_org_created_id
--   auth.idx_user_data_exports_user_id           ⊂  idx_user_data_exports_user_id_status
--   billing.idx_plans_active                     ⊂  idx_plans_active_price
--   tenancy.idx_api_keys_organization            ⊂  idx_api_keys_organization_status
--   tenancy.idx_member_invitations_membership    ⊂  idx_member_invitations_membership_created_id
--
-- Why it matters: four of these sit on `audit.logs`, the heaviest append-only table, so every
-- audit write was maintaining four indexes that no query needs. Foreign-key coverage is
-- unaffected — each kept index leads with the same column.
--
-- CONCURRENTLY so writers are never blocked; IF EXISTS so the file is idempotent, which a
-- non-transactional migration must be because there is no rollback if a statement fails.
DROP INDEX CONCURRENTLY IF EXISTS audit.idx_audit_logs_action_created;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS audit.idx_audit_logs_actor_created;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS audit.idx_audit_logs_created_at;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS audit.idx_audit_logs_org_created;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS auth.idx_user_data_exports_user_id;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS billing.idx_plans_active;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS tenancy.idx_api_keys_organization;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS tenancy.idx_member_invitations_membership;
