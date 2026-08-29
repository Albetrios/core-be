-- Maintenance-role provisioning, DB side: let core_be_maintenance actually operate
-- once an environment points DATABASE_MAINTENANCE_URL at it.
--
-- 1) The six system tables guard access with role-scoped `*_app_access` policies
--    (TO core_be_app) plus a deny_all fallback. A maintenance-pool connection
--    (core_be_maintenance) would hit deny_all on the very tables the system-table
--    maintenance kinds exist for (mail outbox, Stripe webhook ledger, DLQ ledger).
--    Extend those policies to both application roles — this grants nothing beyond
--    what the role's data-plane GRANTs (20260827010000) already allow.
-- 2) GRANT core_be_app TO core_be_maintenance so `SET LOCAL ROLE core_be_app`
--    (the `useApplicationDatabaseRole` test/tooling option) keeps working on
--    maintenance-pool connections; both roles are data-plane peers by design.
ALTER POLICY "dead_letter_jobs_app_access" ON "audit"."dead_letter_jobs" TO core_be_app, core_be_maintenance;--> statement-breakpoint
ALTER POLICY "mail_outbox_app_access" ON "auth"."mail_outbox" TO core_be_app, core_be_maintenance;--> statement-breakpoint
ALTER POLICY "plans_app_access" ON "billing"."plans" TO core_be_app, core_be_maintenance;--> statement-breakpoint
ALTER POLICY "stripe_subscription_tombstones_app_access" ON "billing"."stripe_subscription_tombstones" TO core_be_app, core_be_maintenance;--> statement-breakpoint
ALTER POLICY "stripe_webhook_events_app_access" ON "billing"."stripe_webhook_events" TO core_be_app, core_be_maintenance;--> statement-breakpoint
ALTER POLICY "permissions_app_access" ON "tenancy"."permissions" TO core_be_app, core_be_maintenance;--> statement-breakpoint
GRANT core_be_app TO core_be_maintenance;
