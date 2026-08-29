-- Fixes for four superuser-masked RLS bugs found by running as the RLS-subject roles
-- (first-deployment audit; each reproduced against the exact repository statements):
--
-- 1) auth.users gains a global_retention_cleanup USING arm: the user-tombstone
--    retention worker (hard-delete of old tombstones) and the user-offboarding
--    reconciler (scan for stuck deletion_started_at rows) run under
--    MAINTENANCE_SCOPE.global_retention_cleanup, which previously saw ZERO rows —
--    tombstones were never purged and stuck offboardings never resumed. The arm is
--    USING-only: retention never needs to pass the users WITH CHECK (deletes read
--    the old row; the reconciler resumes via per-user service flows).
--
-- 2) tenancy.organizations WITH CHECK gains the retention arm: Postgres requires an
--    UPDATE's NEW row to stay SELECT-visible when the statement reads the table, so
--    the org soft-delete (DELETE /tenancy/organization tombstone) was rejected with
--    42501 under the RLS-subject application role — after the Stripe cancellation had
--    already run. The sec-new-D3 `deleted_at IS NULL` gate on the tenant SELECT arm is
--    deliberately KEPT (a stale org claim must not read a deleted org), so the
--    tombstoning UPDATE moves to the global-retention context in the service and the
--    retention arm is added to WITH CHECK (mirroring uploads_tenant_isolation; the
--    tombstone never changes public_id/organization identity).
--
-- 3+4) SECURITY DEFINER resolvers for the audit-outbox drain: the drain runs under
--    app.global_admin, which grants NOTHING on tenancy.* — org- and API-key-actor
--    audit rows resolved to zero ids and were permanently discarded after max
--    attempts. Mirror the existing SECURITY DEFINER resolver pattern
--    (billing.resolve_organization_public_id_for_stripe_subscription) with narrow
--    id-lookup functions.
ALTER POLICY "users_self_or_admin_access" ON "auth"."users"
  USING ((((public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (deleted_at IS NULL)) OR (( SELECT current_setting('app.global_admin'::text, true)) = 'true'::text) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text));--> statement-breakpoint
ALTER POLICY "organizations_tenant_isolation" ON "tenancy"."organizations"
  USING ((((public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))) AND (deleted_at IS NULL)) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text))
  WITH CHECK (((public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text));--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit.resolve_organization_ids_for_public_ids (
  public_ids_param TEXT[]
) RETURNS TABLE (id BIGINT, public_id VARCHAR)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, public
AS $$
  SELECT o.id, o.public_id
  FROM tenancy.organizations AS o
  WHERE o.public_id = ANY (public_ids_param);
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit.resolve_api_key_ids_for_public_ids (
  public_ids_param TEXT[]
) RETURNS TABLE (id BIGINT, public_id VARCHAR)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, public
AS $$
  SELECT k.id, k.public_id
  FROM tenancy.api_keys AS k
  WHERE k.public_id = ANY (public_ids_param);
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit.resolve_organization_ids_for_public_ids (TEXT[]) TO core_be_app, core_be_maintenance;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit.resolve_api_key_ids_for_public_ids (TEXT[]) TO core_be_app, core_be_maintenance;
