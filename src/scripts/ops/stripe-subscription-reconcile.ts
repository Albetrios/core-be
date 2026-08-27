/**
 * Runbook-as-code: reconcile Stripe active subscriptions against the local ledger
 * (pnpm ops:stripe:reconcile).
 *
 * Lists every active subscription in the connected Stripe account and compares it to the
 * `billing.subscriptions` table, producing a three-bucket diff: subscriptions present in
 * Stripe but not the database, present in the database (active) but not in Stripe, and
 * subscriptions whose local status disagrees with Stripe.
 *
 * READ-ONLY: never writes to Stripe or Postgres. For each discrepancy it prints commented,
 * parameterized SQL the operator can review and apply manually. Exits 1 when any mismatch is
 * found (so it can gate CI / cron alerts), 0 when the ledger is clean.
 *
 * Usage:
 *   pnpm ops:stripe:reconcile
 */
import '@/shared/config/load-env-files.js';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { isNotNull } from 'drizzle-orm';
import type Stripe from 'stripe';
import { getStripeClient, isStripeConfigured } from '@/infrastructure/payment/stripe.client.js';
import { closeDatabase } from '@/infrastructure/database/connection.js';
import { subscriptions } from '@/domains/billing/sub-domains/subscription/subscription.schema.js';

/** Stripe subscription status treated as the canonical "active" state for reconciliation. */
const STRIPE_ACTIVE_STATUS = 'active';

/** Page size for the Stripe subscriptions list endpoint (max allowed by the API). */
const STRIPE_LIST_PAGE_SIZE = 100;

interface LocalSubscriptionRecord {
  publicId: string;
  organizationId: number;
  providerSubscriptionId: string;
  status: string;
  normalizedStatus: string;
}

interface StripeSubscriptionRecord {
  subscriptionId: string;
  customerId: string | null;
  status: string;
}

interface ReconciliationReport {
  inStripeNotInDb: StripeSubscriptionRecord[];
  inDbNotInStripe: LocalSubscriptionRecord[];
  statusMismatch: Array<{ stripe: StripeSubscriptionRecord; local: LocalSubscriptionRecord }>;
}

function resolveStripeCustomerId(customer: Stripe.Subscription['customer']): string | null {
  if (typeof customer === 'string') return customer;
  return customer?.id ?? null;
}

async function listStripeActiveSubscriptions(): Promise<StripeSubscriptionRecord[]> {
  const stripe = getStripeClient();
  const records: StripeSubscriptionRecord[] = [];
  const page = stripe.subscriptions.list({
    status: STRIPE_ACTIVE_STATUS,
    limit: STRIPE_LIST_PAGE_SIZE,
  });
  for await (const subscription of page) {
    records.push({
      subscriptionId: subscription.id,
      customerId: resolveStripeCustomerId(subscription.customer),
      status: subscription.status,
    });
  }
  return records;
}

async function listLocalStripeSubscriptions(): Promise<LocalSubscriptionRecord[]> {
  return withMaintenanceDatabaseContext(
    MAINTENANCE_SCOPE.global_retention_cleanup,
    async (databaseHandle) => {
      const rows = await databaseHandle
        .select({
          publicId: subscriptions.public_id,
          organizationId: subscriptions.organization_id,
          providerSubscriptionId: subscriptions.provider_subscription_id,
          status: subscriptions.status,
        })
        .from(subscriptions)
        .where(isNotNull(subscriptions.provider_subscription_id));

      return rows
        .filter((row): row is typeof row & { providerSubscriptionId: string } =>
          Boolean(row.providerSubscriptionId),
        )
        .map((row) => ({
          publicId: row.publicId,
          organizationId: row.organizationId,
          providerSubscriptionId: row.providerSubscriptionId,
          status: row.status,
          normalizedStatus: row.status.toLowerCase(),
        }));
    },
  );
}

function buildReconciliationReport({
  stripeRecords,
  localRecords,
}: {
  stripeRecords: StripeSubscriptionRecord[];
  localRecords: LocalSubscriptionRecord[];
}): ReconciliationReport {
  const localById = new Map(localRecords.map((record) => [record.providerSubscriptionId, record]));
  const stripeById = new Map(stripeRecords.map((record) => [record.subscriptionId, record]));

  const inStripeNotInDb: StripeSubscriptionRecord[] = [];
  const statusMismatch: ReconciliationReport['statusMismatch'] = [];

  for (const stripeRecord of stripeRecords) {
    const local = localById.get(stripeRecord.subscriptionId);
    if (!local) {
      inStripeNotInDb.push(stripeRecord);
      continue;
    }
    if (local.normalizedStatus !== stripeRecord.status) {
      statusMismatch.push({ stripe: stripeRecord, local });
    }
  }

  const inDbNotInStripe = localRecords.filter(
    (record) =>
      record.normalizedStatus === STRIPE_ACTIVE_STATUS &&
      !stripeById.has(record.providerSubscriptionId),
  );

  return { inStripeNotInDb, inDbNotInStripe, statusMismatch };
}

function printInStripeNotInDb(records: StripeSubscriptionRecord[]): void {
  console.log(`\n[in_stripe_not_in_db] ${records.length} subscription(s)`);
  for (const record of records) {
    console.log(
      `  - stripe_subscription=${record.subscriptionId} customer=${record.customerId ?? 'unknown'} status=${record.status}`,
    );
    console.log('    -- Present in Stripe, missing locally. Investigate before backfilling:');
    console.log(
      `    -- SELECT * FROM billing.subscriptions WHERE provider_subscription_id = '${record.subscriptionId}';`,
    );
  }
}

function printInDbNotInStripe(records: LocalSubscriptionRecord[]): void {
  console.log(`\n[in_db_not_in_stripe] ${records.length} subscription(s)`);
  for (const record of records) {
    console.log(
      `  - public_id=${record.publicId} organization_id=${record.organizationId} provider_subscription_id=${record.providerSubscriptionId} status=${record.status}`,
    );
    console.log('    -- Active locally but not active in Stripe. Verify, then if confirmed stale:');
    console.log(
      `    -- UPDATE billing.subscriptions SET status = 'CANCELED', canceled_at = now() WHERE provider_subscription_id = '${record.providerSubscriptionId}';`,
    );
  }
}

function printStatusMismatch(records: ReconciliationReport['statusMismatch']): void {
  console.log(`\n[status_mismatch] ${records.length} subscription(s)`);
  for (const { stripe, local } of records) {
    console.log(
      `  - provider_subscription_id=${local.providerSubscriptionId} local_status=${local.status} stripe_status=${stripe.status}`,
    );
    console.log('    -- Status disagrees. Confirm Stripe is source of truth, then align:');
    console.log(
      `    -- UPDATE billing.subscriptions SET status = '${stripe.status.toUpperCase()}', updated_at = now() WHERE provider_subscription_id = '${local.providerSubscriptionId}';`,
    );
  }
}

function printReport(report: ReconciliationReport): number {
  const mismatchCount =
    report.inStripeNotInDb.length + report.inDbNotInStripe.length + report.statusMismatch.length;

  if (mismatchCount === 0) {
    console.log('Stripe ↔ database reconciliation: no mismatches.');
    return 0;
  }

  console.log(`Stripe ↔ database reconciliation: ${mismatchCount} mismatch(es) found.`);
  printInStripeNotInDb(report.inStripeNotInDb);
  printInDbNotInStripe(report.inDbNotInStripe);
  printStatusMismatch(report.statusMismatch);
  console.log('\nReview the SQL above and apply manually — this script never writes.');
  return 1;
}

async function main(): Promise<void> {
  if (!isStripeConfigured()) {
    console.error('STRIPE_SECRET_KEY is not configured — cannot reconcile.');
    process.exitCode = 1;
    return;
  }

  try {
    const [stripeRecords, localRecords] = await Promise.all([
      listStripeActiveSubscriptions(),
      listLocalStripeSubscriptions(),
    ]);
    const report = buildReconciliationReport({ stripeRecords, localRecords });
    process.exitCode = printReport(report);
  } finally {
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error('stripe-subscription-reconcile failed:', error);
  process.exitCode = 1;
});
