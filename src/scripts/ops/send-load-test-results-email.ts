/**
 * Run load tests (health stress + API stress) and email the results.
 * Requires: server running with high rate limit (pnpm dev:loadtest), RESEND_API_KEY,
 * and TEST_RESULT_EMAIL_TO.
 * Run: pnpm run tool:send-load-test-results-email
 */
import '@/shared/config/load-env-files.js';
import { PROJECT_DISPLAY_NAME } from '@/shared/constants/project-identity.constants.js';
import { spawn } from 'node:child_process';
import { sendEmail, isMailConfigured } from '@/infrastructure/mail/mail.service.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
      });
    });
  });
}

function lastLines(text: string, count: number): string {
  const lines = text.trim().split('\n');
  return lines.slice(-count).join('\n');
}

async function main(): Promise<void> {
  if (!isMailConfigured()) {
    logger.warn('Mail service not configured (RESEND_API_KEY missing); skipping load test email.');
    process.exitCode = 1;
    return;
  }

  const recipientsEnv = process.env.TEST_RESULT_EMAIL_TO;
  if (!recipientsEnv) {
    logger.warn('TEST_RESULT_EMAIL_TO not set; skipping load test email.');
    process.exitCode = 1;
    return;
  }

  const to = recipientsEnv
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (to.length === 0) {
    logger.warn('No email recipients; skipping.');
    process.exitCode = 1;
    return;
  }

  const dateTime = new Date().toISOString();

  logger.info('Running health stress...');
  const healthResult = await runCommand('pnpm', ['load:stress'], {
    BASE_URL,
  });
  const healthOk = healthResult.exitCode === 0;

  logger.info('Fetching credentials for API stress...');
  const credsResult = await runCommand('pnpm', ['run', 'tool:load-test-credentials'], {
    BASE_URL,
  });
  let testToken = '';
  let testOrgId = '';
  const tokenMatch = credsResult.stdout.match(/export TEST_TOKEN="([^"]+)"/);
  const organizationMatch = credsResult.stdout.match(/export TEST_ORG_ID="([^"]+)"/);
  if (tokenMatch) testToken = tokenMatch[1] ?? '';
  if (organizationMatch) testOrgId = organizationMatch[1] ?? '';

  let apiResult = { stdout: '', stderr: '', exitCode: -1 };
  if (testToken && testOrgId) {
    logger.info('Running API stress...');
    apiResult = await runCommand('pnpm', ['load:stress:api'], {
      BASE_URL,
      TEST_TOKEN: testToken,
      TEST_ORG_ID: testOrgId,
    });
  } else {
    apiResult.stdout = 'Could not get TEST_TOKEN or TEST_ORG_ID; API stress skipped.';
  }
  const apiOk = apiResult.exitCode === 0;

  const overallOk = healthOk && apiOk;
  const subject = `${PROJECT_DISPLAY_NAME} Load Test Results: ${overallOk ? 'PASS' : 'FAIL'} — ${dateTime}`;

  const summaryLines: string[] = [
    `Load test run at ${dateTime}`,
    '',
    `Health stress: ${healthOk ? 'PASS' : 'FAIL'} (exit ${healthResult.exitCode})`,
    `API stress:   ${apiOk ? 'PASS' : 'FAIL'} (exit ${apiResult.exitCode})`,
    '',
    '--- Health stress (last 50 lines) ---',
    lastLines(healthResult.stdout + healthResult.stderr, 50),
    '',
    '--- API stress (last 50 lines) ---',
    lastLines(apiResult.stdout + apiResult.stderr, 50),
  ];
  const text = summaryLines.join('\n');

  const html = [
    `<p>Load test run at <strong>${dateTime}</strong></p>`,
    `<p><strong>Health stress:</strong> ${healthOk ? 'PASS' : 'FAIL'} (exit ${healthResult.exitCode})</p>`,
    `<p><strong>API stress:</strong> ${apiOk ? 'PASS' : 'FAIL'} (exit ${apiResult.exitCode})</p>`,
    '<h3>Health stress (tail)</h3>',
    '<pre style="white-space:pre-wrap;font-size:12px;">',
    escapeHtml(lastLines(healthResult.stdout + healthResult.stderr, 50)),
    '</pre>',
    '<h3>API stress (tail)</h3>',
    '<pre style="white-space:pre-wrap;font-size:12px;">',
    escapeHtml(lastLines(apiResult.stdout + apiResult.stderr, 50)),
    '</pre>',
  ].join('\n');

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const messageId = await sendEmail({
    to,
    subject,
    text,
    html,
    tags: [
      { name: 'type', value: 'load-test-results' },
      { name: 'status', value: overallOk ? 'pass' : 'fail' },
    ],
  });

  if (!messageId) {
    logger.warn({ to }, 'load-test-results.email.send.failed');
    process.exitCode = 1;
  } else {
    logger.info({ to, messageId }, 'load-test-results.email.send.success');
  }
}

void main();
