-- RLS policy hygiene (B-track, one pass):
-- 1) InitPlan hoisting: every bare current_setting('app.*') comparison is wrapped in a
--    scalar subselect (SELECT current_setting(...)) so the planner evaluates it ONCE per
--    statement (InitPlan) instead of once per row — the documented Postgres RLS
--    performance pattern. Semantics are identical (current_setting is stable).
-- 2) Dead-arm removal: auth.sessions' sessions_user_access policy carried an
--    app.current_session_refresh_token_hash arm that NO code path ever sets (no session
--    context kind, no setter). The arm is removed; the rls-table-scope-map test pins this.
-- ALTER POLICY preserves each policy's command, roles, and permissiveness.

ALTER POLICY "audit_logs_tenant_isolation_delete" ON "audit"."logs"
  USING ((( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text));--> statement-breakpoint
ALTER POLICY "audit_logs_tenant_isolation_insert" ON "audit"."logs"
  WITH CHECK (((organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))) OR ((organization_id IS NULL) AND (( SELECT current_setting('app.system_audit_insert'::text, true)) = 'true'::text))));--> statement-breakpoint
ALTER POLICY "audit_logs_tenant_isolation_select" ON "audit"."logs"
  USING (((organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text) OR (( SELECT current_setting('app.global_admin'::text, true)) = 'true'::text)));--> statement-breakpoint
ALTER POLICY "audit_logs_user_export_select" ON "audit"."logs"
  USING ((actor_user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL)))));--> statement-breakpoint
ALTER POLICY "audit_outbox_drain_delete" ON "audit"."outbox"
  USING ((( SELECT current_setting('app.audit_outbox_drain'::text, true)) = 'true'::text));--> statement-breakpoint
ALTER POLICY "audit_outbox_drain_select" ON "audit"."outbox"
  USING ((( SELECT current_setting('app.audit_outbox_drain'::text, true)) = 'true'::text));--> statement-breakpoint
ALTER POLICY "audit_outbox_drain_update" ON "audit"."outbox"
  USING ((( SELECT current_setting('app.audit_outbox_drain'::text, true)) = 'true'::text))
  WITH CHECK ((( SELECT current_setting('app.audit_outbox_drain'::text, true)) = 'true'::text));--> statement-breakpoint
ALTER POLICY "audit_outbox_tenant_isolation_insert" ON "audit"."outbox"
  WITH CHECK ((((organization_public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))) OR ((organization_public_id IS NULL) AND (( SELECT current_setting('app.system_audit_insert'::text, true)) = 'true'::text))));--> statement-breakpoint
ALTER POLICY "auth_methods_self_or_admin_access" ON "auth"."auth_methods"
  USING (((user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL)))) OR (( SELECT current_setting('app.global_admin'::text, true)) = 'true'::text)))
  WITH CHECK (((user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL)))) OR (( SELECT current_setting('app.global_admin'::text, true)) = 'true'::text)));--> statement-breakpoint
ALTER POLICY "mfa_methods_owner_access" ON "auth"."mfa_methods"
  USING ((user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL)))))
  WITH CHECK ((user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL)))));--> statement-breakpoint
ALTER POLICY "mfa_recovery_codes_owner_access" ON "auth"."mfa_recovery_codes"
  USING ((user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL)))))
  WITH CHECK ((user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL)))));--> statement-breakpoint
ALTER POLICY "sessions_user_access" ON "auth"."sessions"
  USING (((user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL)))) OR ((public_id)::text = ( SELECT current_setting('app.current_session_public_id'::text, true))) OR ((token_hash)::text = ( SELECT current_setting('app.current_session_token_hash'::text, true))) OR (( SELECT current_setting('app.session_retention_cleanup'::text, true)) = 'true'::text)))
  WITH CHECK (((user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL)))) OR ((public_id)::text = ( SELECT current_setting('app.current_session_public_id'::text, true))) OR ((token_hash)::text = ( SELECT current_setting('app.current_session_token_hash'::text, true))) OR (( SELECT current_setting('app.session_retention_cleanup'::text, true)) = 'true'::text)));--> statement-breakpoint
ALTER POLICY "user_data_exports_owner_access" ON "auth"."user_data_exports"
  USING (((user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL)))) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text)))
  WITH CHECK (((user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL)))) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text)));--> statement-breakpoint
ALTER POLICY "user_notification_preferences_user_access" ON "auth"."user_notification_preferences"
  USING ((user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL)))))
  WITH CHECK ((user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL)))));--> statement-breakpoint
ALTER POLICY "user_settings_owner_access" ON "auth"."user_settings"
  USING ((user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL)))))
  WITH CHECK ((user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL)))));--> statement-breakpoint
ALTER POLICY "users_self_or_admin_access" ON "auth"."users"
  USING (((((public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (deleted_at IS NULL)) OR (( SELECT current_setting('app.global_admin'::text, true)) = 'true'::text)))
  WITH CHECK ((((public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) OR (( SELECT current_setting('app.global_admin'::text, true)) = 'true'::text)));--> statement-breakpoint
ALTER POLICY "webauthn_credentials_owner_access" ON "auth"."webauthn_credentials"
  USING ((user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL)))))
  WITH CHECK ((user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL)))));--> statement-breakpoint
ALTER POLICY "subscriptions_tenant_isolation" ON "billing"."subscriptions"
  USING (((organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text)))
  WITH CHECK ((organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))));--> statement-breakpoint
ALTER POLICY "notifications_owner_access" ON "notify"."notifications"
  USING ((user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL)))));--> statement-breakpoint
ALTER POLICY "notifications_tenant_isolation" ON "notify"."notifications"
  USING ((((organization_id IS NOT NULL) AND (organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true)))))) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text)))
  WITH CHECK (((organization_id IS NOT NULL) AND (organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true)))))));--> statement-breakpoint
ALTER POLICY "webhook_delivery_attempts_tenant_isolation" ON "notify"."webhook_delivery_attempts"
  USING (((webhook_id IN ( SELECT webhooks.id    FROM notify.webhooks   WHERE (webhooks.organization_id = ( SELECT organizations.id            FROM tenancy.organizations           WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))))) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text)))
  WITH CHECK ((webhook_id IN ( SELECT webhooks.id    FROM notify.webhooks   WHERE (webhooks.organization_id = ( SELECT organizations.id            FROM tenancy.organizations           WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))))));--> statement-breakpoint
ALTER POLICY "webhooks_tenant_isolation" ON "notify"."webhooks"
  USING (((organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text)))
  WITH CHECK ((organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))));--> statement-breakpoint
ALTER POLICY "api_keys_tenant_isolation" ON "tenancy"."api_keys"
  USING (((organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text)))
  WITH CHECK ((organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))));--> statement-breakpoint
ALTER POLICY "member_invitations_tenant_isolation" ON "tenancy"."member_invitations"
  USING (((membership_id IN ( SELECT memberships.id    FROM tenancy.memberships   WHERE (memberships.organization_id = ( SELECT organizations.id            FROM tenancy.organizations           WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))))) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text)))
  WITH CHECK ((membership_id IN ( SELECT memberships.id    FROM tenancy.memberships   WHERE (memberships.organization_id = ( SELECT organizations.id            FROM tenancy.organizations           WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))))));--> statement-breakpoint
ALTER POLICY "memberships_tenant_isolation" ON "tenancy"."memberships"
  USING (((organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text)))
  WITH CHECK ((organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))));--> statement-breakpoint
ALTER POLICY "memberships_user_self_discovery" ON "tenancy"."memberships"
  USING (((( SELECT current_setting('app.current_user_id'::text, true)) IS NOT NULL) AND (( SELECT current_setting('app.current_user_id'::text, true)) <> ''::text) AND (user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL))))));--> statement-breakpoint
ALTER POLICY "organization_notification_policies_tenant_isolation" ON "tenancy"."organization_notification_policies"
  USING (((organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text)))
  WITH CHECK ((organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))));--> statement-breakpoint
ALTER POLICY "organization_settings_tenant_isolation" ON "tenancy"."organization_settings"
  USING (((organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text)))
  WITH CHECK ((organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))));--> statement-breakpoint
ALTER POLICY "organizations_tenant_isolation" ON "tenancy"."organizations"
  USING (((((public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))) AND (deleted_at IS NULL)) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text)))
  WITH CHECK (((public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))));--> statement-breakpoint
ALTER POLICY "organizations_user_discovery" ON "tenancy"."organizations"
  USING (((deleted_at IS NULL) AND (( SELECT current_setting('app.current_user_id'::text, true)) IS NOT NULL) AND (( SELECT current_setting('app.current_user_id'::text, true)) <> ''::text) AND ((owner_user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL)))) OR tenancy.user_has_active_membership_for_organization(id, ( SELECT current_setting('app.current_user_id'::text, true))))))
  WITH CHECK (((( SELECT current_setting('app.current_user_id'::text, true)) IS NOT NULL) AND (( SELECT current_setting('app.current_user_id'::text, true)) <> ''::text) AND (owner_user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL))))));--> statement-breakpoint
ALTER POLICY "role_permissions_tenant_isolation" ON "tenancy"."role_permissions"
  USING (((role_id IN ( SELECT roles.id    FROM tenancy.roles   WHERE (roles.organization_id = ( SELECT organizations.id            FROM tenancy.organizations           WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))))) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text)))
  WITH CHECK ((role_id IN ( SELECT roles.id    FROM tenancy.roles   WHERE (roles.organization_id = ( SELECT organizations.id            FROM tenancy.organizations           WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))))));--> statement-breakpoint
ALTER POLICY "roles_tenant_isolation" ON "tenancy"."roles"
  USING (((organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text)))
  WITH CHECK ((organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true))))));--> statement-breakpoint
ALTER POLICY "uploads_owner_access" ON "upload"."uploads"
  USING (((organization_id IS NULL) AND (user_id = ( SELECT users.id    FROM auth.users   WHERE (((users.public_id)::text = ( SELECT current_setting('app.current_user_id'::text, true))) AND (users.deleted_at IS NULL))))));--> statement-breakpoint
ALTER POLICY "uploads_tenant_isolation" ON "upload"."uploads"
  USING ((((organization_id IS NOT NULL) AND (organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true)))))) OR (( SELECT current_setting('app.global_retention_cleanup'::text, true)) = 'true'::text)))
  WITH CHECK (((organization_id IS NOT NULL) AND (organization_id = ( SELECT organizations.id    FROM tenancy.organizations   WHERE ((organizations.public_id)::text = ( SELECT current_setting('app.current_organization_id'::text, true)))))));--> statement-breakpoint
