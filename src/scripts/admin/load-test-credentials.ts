/**
 * Obtain TEST_TOKEN and TEST_ORG_ID for k6 load tests (the nightly gate, daily-ops, billing, webhooks).
 * Requires server running and full seed (demo@example.com / DemoPassword123!).
 * The active organization rides the token's `org` claim, so the printed token is minted scoped to
 * the demo user's team organization: login → `GET /users/me/organizations` →
 * `POST /auth/switch-to-organization`.
 * Run: pnpm run tool:load-test-credentials
 */
import '@/shared/config/load-env-files.js';
import { signInOverApi } from '@/scripts/admin/api-sign-in.util.js';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const API_PREFIX = `${BASE_URL}/api/v1`;
const EMAIL = process.env.DEMO_EMAIL ?? 'demo@example.com';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'DemoPassword123!';

async function main() {
  const token = await signInOverApi({ apiPrefix: API_PREFIX, email: EMAIL, password: PASSWORD });

  const organizationsResponse = await fetch(`${API_PREFIX}/users/me/organizations`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!organizationsResponse.ok) {
    console.error('List organizations failed:', organizationsResponse.status);
    process.exit(1);
  }

  const organizationsBody = (await organizationsResponse.json()) as {
    data?: Array<{ id: string; type?: string }>;
  };
  // The load scenarios exercise team-organization routes; a personal organization cannot stand in.
  const organization = (organizationsBody.data ?? []).find((item) => item.type === 'TEAM');

  let scopedToken = token;
  if (organization) {
    const switchResponse = await fetch(`${API_PREFIX}/auth/switch-to-organization`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization_id: organization.id }),
    });

    if (!switchResponse.ok) {
      const text = await switchResponse.text();
      console.error('Switch to organization failed:', switchResponse.status, text);
      process.exit(1);
    }

    const switchBody = (await switchResponse.json()) as {
      data?: { access_token?: string };
    };
    if (!switchBody.data?.access_token) {
      console.error('Switch-to-organization response missing access_token');
      process.exit(1);
    }
    scopedToken = switchBody.data.access_token;
  }

  console.log('Copy and paste for k6 (daily-ops, billing, webhooks):');
  console.log('');
  console.log(`export TEST_TOKEN="${scopedToken}"`);
  if (organization) {
    console.log(`export TEST_ORG_ID="${organization.id}"`);
  } else {
    console.log(
      'export TEST_ORG_ID=<your-team-organization-public-id>  # No team organization found',
    );
  }
  console.log('');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
