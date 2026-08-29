/**
 * Obtain TEST_TOKEN and TEST_ORG_ID for k6 load tests (daily-ops, billing, webhooks).
 * Requires server running and full seed (demo@example.com / DemoPassword123!).
 * Run: pnpm run tool:load-test-credentials
 */
import '@/shared/config/load-env-files.js';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const API_PREFIX = `${BASE_URL}/api/v1`;
const EMAIL = process.env.DEMO_EMAIL ?? 'demo@example.com';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'DemoPassword123!';

async function main() {
  const loginResponse = await fetch(`${API_PREFIX}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  if (!loginResponse.ok) {
    const text = await loginResponse.text();
    console.error('Login failed:', loginResponse.status, text);
    process.exit(1);
  }

  const loginBody = (await loginResponse.json()) as {
    data?: { access_token?: string };
  };
  const token = loginBody.data?.access_token;
  if (!token) {
    console.error('Login response missing access_token');
    process.exit(1);
  }

  const orgsResponse = await fetch(`${API_PREFIX}/tenancy/organizations`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!orgsResponse.ok) {
    console.error('List organizations failed:', orgsResponse.status);
    process.exit(1);
  }

  const orgsBody = (await orgsResponse.json()) as {
    data?: Array<{ id: string }>;
  };
  const items = orgsBody.data ?? [];
  const firstOrgId = items[0]?.id;

  console.log('Copy and paste for k6 (daily-ops, billing, webhooks):');
  console.log('');
  console.log(`export TEST_TOKEN="${token}"`);
  if (firstOrgId) {
    console.log(`export TEST_ORG_ID="${firstOrgId}"`);
  } else {
    console.log('export TEST_ORG_ID=<your-organization-public-id>  # No organizations found');
  }
  console.log('');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
