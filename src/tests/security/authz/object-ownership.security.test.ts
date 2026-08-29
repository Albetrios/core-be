import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { generateTestToken, generateTestTokenAndSession } from '@/tests/helpers/test-auth.js';
import {
  seedTwoOrganizationsWithSubscriptions,
  seedUploadForOrganization,
} from '@/tests/helpers/test-organization.js';
import { createTestNotification } from '@/tests/factories/notification.factory.js';
import { createTestUserDataExport } from '@/tests/factories/user-data-export.factory.js';
import { seedRecentStepUpForTestUser } from '@/tests/helpers/test-step-up.helper.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { database } from '@/infrastructure/database/connection.js';
import { uploads } from '@/domains/upload/upload.schema.js';
import { notifications } from '@/domains/notify/sub-domains/notification/notification.schema.js';
import { sessions } from '@/domains/auth/sub-domains/auth-session/auth-session.schema.js';
import { auth_methods } from '@/domains/auth/sub-domains/auth-method/auth-method.schema.js';
import { webauthn_credentials } from '@/domains/auth/sub-domains/auth-webauthn/webauthn-credential.schema.js';

/**
 * Object-ownership (BOLA) attack matrix — Phase 2 of the in-house authorization
 * matrix (route-authorization-model.json). For each model, a different principal
 * is denied the victim's object (`user`→404, `organization`→404), the legitimate owner
 * still succeeds (baseline), and denied writes leave state unchanged
 * (verifyNoMutation). e2e — runs in CI (Postgres + Redis required).
 */
describe('Security: object-ownership BOLA matrix', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const created = await createTestApp();
    app = created.app;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  // ─── model: user — two peer users; B must never reach A's object ────────────

  async function twoUsers() {
    const victim = await createTestUser();
    const attacker = await createTestUser();
    const victimOrganization = await createTestOrganization({ ownerUserId: victim.id });
    const attackerOrganization = await createTestOrganization({ ownerUserId: attacker.id });
    const victimToken = await generateTestToken({
      userId: victim.public_id,
      organizationPublicId: victimOrganization.public_id,
    });
    const attackerToken = await generateTestToken({
      userId: attacker.public_id,
      organizationPublicId: attackerOrganization.public_id,
    });
    return { victim, attacker, victimToken, attackerToken };
  }

  // Credential endpoints (sessions, MFA, auth methods) are gated by recent step-up bound to
  // the caller's session (sec-A2/A7): a stolen bearer alone cannot use them. This mints a
  // session-bound token and seeds the step-up sentinel so the request clears the gate and
  // actually exercises the ownership layer beneath it.
  async function userWithStepUp() {
    const user = await createTestUser();
    const { token, sessionPublicId } = await generateTestTokenAndSession({
      userId: user.public_id,
    });
    await seedRecentStepUpForTestUser(user.public_id, sessionPublicId);
    return { user, token, sessionPublicId };
  }

  describe('model: user — uploads', () => {
    it("attacker GET victim's upload → 404", async () => {
      const { victim, attackerToken } = await twoUsers();
      const upload = await seedUploadForOrganization({ userId: victim.id });
      const res = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/uploads/${upload.public_id}`),
        token: attackerToken,
      });
      expect(res.statusCode).toBe(404);
    });

    it('baseline: owner GET own upload → 200', async () => {
      const { victim, victimToken } = await twoUsers();
      const upload = await seedUploadForOrganization({ userId: victim.id });
      const res = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/uploads/${upload.public_id}`),
        token: victimToken,
      });
      expect(res.statusCode).toBe(200);
    });

    it("attacker DELETE victim's upload → 404 and row not soft-deleted", async () => {
      const { victim, attackerToken } = await twoUsers();
      const upload = await seedUploadForOrganization({ userId: victim.id });
      const res = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/uploads/${upload.public_id}`),
        token: attackerToken,
      });
      expect(res.statusCode).toBe(404);
      const [row] = await database
        .select()
        .from(uploads)
        .where(eq(uploads.public_id, upload.public_id));
      expect(row?.deleted_at).toBeNull();
    });

    it("attacker POST confirm on victim's upload → 404", async () => {
      // Finalizing someone else's pending upload is owner-scoped: the lookup is
      // filtered to the caller's user_id, so the attacker never resolves the row.
      const { victim, attackerToken } = await twoUsers();
      const upload = await seedUploadForOrganization({ userId: victim.id });
      const res = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/uploads/${upload.public_id}/confirm`),
        token: attackerToken,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('model: user — notifications', () => {
    it("attacker GET victim's notification → 404", async () => {
      const { victim, attackerToken } = await twoUsers();
      const notification = await createTestNotification({ userId: victim.id });
      const res = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/notify/notifications/${notification.public_id}`),
        token: attackerToken,
      });
      expect(res.statusCode).toBe(404);
    });

    it('baseline: owner GET own notification → 200', async () => {
      const { victim, victimToken } = await twoUsers();
      const notification = await createTestNotification({ userId: victim.id });
      const res = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/notify/notifications/${notification.public_id}`),
        token: victimToken,
      });
      expect(res.statusCode).toBe(200);
    });

    it("attacker DELETE victim's notification → 404 and row still present", async () => {
      const { victim, attackerToken } = await twoUsers();
      const notification = await createTestNotification({ userId: victim.id });
      const res = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/notify/notifications/${notification.public_id}`),
        token: attackerToken,
      });
      expect(res.statusCode).toBe(404);
      const rows = await database
        .select()
        .from(notifications)
        .where(eq(notifications.public_id, notification.public_id));
      expect(rows).toHaveLength(1);
    });

    it("attacker PATCH read on victim's notification → 404 and still unread", async () => {
      const { victim, attackerToken } = await twoUsers();
      const notification = await createTestNotification({ userId: victim.id });
      const res = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath(`/notify/notifications/${notification.public_id}/read`),
        token: attackerToken,
      });
      expect(res.statusCode).toBe(404);
      const [row] = await database
        .select()
        .from(notifications)
        .where(eq(notifications.public_id, notification.public_id));
      expect(row?.is_read).toBe(false);
    });
  });

  describe('model: user — data exports', () => {
    it("attacker GET victim's data export → 404", async () => {
      const { victim, attackerToken } = await twoUsers();
      const exportRow = await createTestUserDataExport({ userId: victim.id });
      const res = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/users/me/data-export/${exportRow.public_id}`),
        token: attackerToken,
      });
      expect(res.statusCode).toBe(404);
    });

    it('baseline: owner GET own data export → 200', async () => {
      const { victim, victimToken } = await twoUsers();
      const exportRow = await createTestUserDataExport({ userId: victim.id });
      const res = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/users/me/data-export/${exportRow.public_id}`),
        token: victimToken,
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // Step-up-gated credential endpoints (sec-A7): verify the ownership layer BENEATH the
  // step-up gate. Both parties hold a recent step-up, so a denial proves ownership-scoping
  // (not merely the step-up gate). A dedicated "no step-up → 403" case documents the gate.

  describe('model: user — sessions (step-up gated)', () => {
    it("attacker (with step-up) DELETE victim's session → 404 and session not revoked", async () => {
      const attacker = await userWithStepUp();
      const victim = await createTestUser();
      const { sessionPublicId: victimSession } = await generateTestTokenAndSession({
        userId: victim.public_id,
      });
      const res = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/auth/me/sessions/${victimSession}`),
        token: attacker.token,
      });
      expect(res.statusCode).toBe(404);
      const [row] = await database
        .select()
        .from(sessions)
        .where(eq(sessions.public_id, victimSession));
      expect(row?.is_revoked).toBe(false);
    });

    it('baseline: owner (with step-up) DELETE own session → 204', async () => {
      const owner = await userWithStepUp();
      const { sessionPublicId: otherSession } = await generateTestTokenAndSession({
        userId: owner.user.public_id,
      });
      const res = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/auth/me/sessions/${otherSession}`),
        token: owner.token,
      });
      expect(res.statusCode).toBe(204);
    });

    it('step-up gate: without recent step-up, DELETE own session → 403', async () => {
      const user = await createTestUser();
      const { token, sessionPublicId } = await generateTestTokenAndSession({
        userId: user.public_id,
      });
      const res = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/auth/me/sessions/${sessionPublicId}`),
        token,
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('model: user — MFA methods (step-up gated)', () => {
    it("attacker (with step-up) DELETE victim's MFA method → denied and not revoked", async () => {
      const attacker = await userWithStepUp();
      const victim = await createTestUser();
      const [victimMfa] = await database
        .insert(auth_methods)
        .values({
          public_id: generatePublicId('authMethod'),
          user_id: victim.id,
          method_type: 'MFA_TOTP',
          verified_at: new Date(),
        })
        .returning();
      const res = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/auth/me/mfa/${victimMfa!.public_id}`),
        token: attacker.token,
      });
      // step-up is satisfied, so a denial here is the ownership check, not the step-up gate
      expect(res.statusCode).not.toBe(403);
      expect([401, 404]).toContain(res.statusCode);
      const [row] = await database
        .select()
        .from(auth_methods)
        .where(eq(auth_methods.public_id, victimMfa!.public_id));
      expect(row?.revoked_at).toBeNull();
    });

    it('step-up gate: without recent step-up, DELETE MFA method → 403', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const res = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/auth/me/mfa/${generatePublicId('authMethod')}`),
        token,
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('model: user — auth methods (step-up gated)', () => {
    it("attacker (with step-up) DELETE victim's auth method → denied and not revoked", async () => {
      const attacker = await userWithStepUp();
      const victim = await createTestUser();
      const [victimMethod] = await database
        .insert(auth_methods)
        .values({
          public_id: generatePublicId('authMethod'),
          user_id: victim.id,
          method_type: 'PASSWORD',
          is_primary: true,
        })
        .returning();
      const res = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/auth/me/auth-methods/${victimMethod!.public_id}`),
        token: attacker.token,
      });
      expect(res.statusCode).not.toBe(403);
      expect([401, 404]).toContain(res.statusCode);
      const [row] = await database
        .select()
        .from(auth_methods)
        .where(eq(auth_methods.public_id, victimMethod!.public_id));
      expect(row?.revoked_at).toBeNull();
    });

    it('step-up gate: without recent step-up, DELETE auth method → 403', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const res = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/auth/me/auth-methods/${generatePublicId('authMethod')}`),
        token,
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('model: user — WebAuthn passkeys (step-up gated)', () => {
    it("attacker (with step-up) DELETE victim's passkey → denied and not revoked", async () => {
      const attacker = await userWithStepUp();
      const victim = await createTestUser();
      const [victimCredential] = await database
        .insert(webauthn_credentials)
        .values({
          public_id: generatePublicId('webauthnCredential'),
          user_id: victim.id,
          credential_id: `raw-${generatePublicId('webauthnCredential')}`,
          public_key: 'victim-key',
        })
        .returning();
      const res = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/auth/me/webauthn/credentials/${victimCredential!.public_id}`),
        token: attacker.token,
      });
      // step-up is satisfied, so a denial here is the ownership check (404), not the step-up gate.
      // The attacker's owner-scoped list never contains the victim's row, so it resolves to 404.
      expect(res.statusCode).not.toBe(403);
      expect([401, 404]).toContain(res.statusCode);
      const [row] = await database
        .select()
        .from(webauthn_credentials)
        .where(eq(webauthn_credentials.public_id, victimCredential!.public_id));
      expect(row?.revoked_at).toBeNull();
    });

    it('step-up gate: without recent step-up, DELETE passkey → 403', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const res = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/auth/me/webauthn/credentials/${generatePublicId('webauthnCredential')}`),
        token,
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ─── model: organization — member of organization A must not reach organization B's object ─────────────

  describe('model: organization — subscriptions (cross-organization)', () => {
    it("member of organization A GET organization B's subscription → 404", async () => {
      const fixture = await seedTwoOrganizationsWithSubscriptions();
      const tokenScopedToOrgA = await generateTestToken({
        userId: fixture.userA.public_id,
        organizationPublicId: fixture.organizationA.public_id,
      });
      const res = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/billing/subscriptions/${fixture.subscriptionInB.public_id}`),
        token: tokenScopedToOrgA,
        organizationPublicId: fixture.organizationA.public_id,
      });
      expect(res.statusCode).toBe(404);
    });

    it("member of organization A GET organization B's subscription payment-setup → 404", async () => {
      const fixture = await seedTwoOrganizationsWithSubscriptions();
      const tokenScopedToOrgA = await generateTestToken({
        userId: fixture.userA.public_id,
        organizationPublicId: fixture.organizationA.public_id,
      });
      const res = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(
          `/billing/subscriptions/${fixture.subscriptionInB.public_id}/payment-setup`,
        ),
        token: tokenScopedToOrgA,
        organizationPublicId: fixture.organizationA.public_id,
      });
      expect(res.statusCode).toBe(404);
    });

    it('baseline: member GET own organization subscription → 200', async () => {
      const fixture = await seedTwoOrganizationsWithSubscriptions();
      const tokenScopedToOrgA = await generateTestToken({
        userId: fixture.userA.public_id,
        organizationPublicId: fixture.organizationA.public_id,
      });
      const res = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/billing/subscriptions/${fixture.subscriptionInA.public_id}`),
        token: tokenScopedToOrgA,
        organizationPublicId: fixture.organizationA.public_id,
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
