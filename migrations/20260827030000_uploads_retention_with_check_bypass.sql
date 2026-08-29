-- Fix (pre-existing, superuser-masked): the pending-sweep worker UPDATEs upload rows
-- (auto-confirm to UPLOADED / mark FAILED) under the global-retention maintenance
-- context, but uploads_tenant_isolation carried the retention bypass ONLY in USING —
-- WITH CHECK rejected those writes under any RLS-subject role (production core_be_app,
-- and the maintenance role). Add the bypass arm to WITH CHECK; the sweep never changes
-- organization_id, and bypass authority remains GUC-gated (role-gated once
-- DATABASE_MAINTENANCE_URL arm-tightening lands).
ALTER POLICY "uploads_tenant_isolation" ON "upload"."uploads"
  WITH CHECK ((((organization_id IS NOT NULL) AND (organization_id = ( SELECT organizations.id FROM tenancy.organizations WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true)))))) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text)));
