// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

let hostingUrl: string;
/** The deployed stack's test-support secret (sandbox only). Never log it. */
let testSupportSecret = '';

// ── Stack outputs (deployed by test/global-setup.ts) ────────────────────────

test.beforeAll(async () => {
  if (ENV === 'sandbox') {
    // The stack was deployed once for this run by `globalSetup` (test/global-setup.ts);
    // this hook runs per worker, so a retry re-reads the outputs instead of redeploying.

    const outputs = JSON.parse(readFileSync(join(projectRoot, '.blocks-sandbox', 'outputs.json'), 'utf-8'));
    const stackOutputs = Object.values(outputs)[0] as Record<string, string>;
    // CDK appends a hash suffix to output keys — find by prefix
    const hostingKey = Object.keys(stackOutputs).find(k => k.startsWith('HostingHostingUrl'));
    hostingUrl = hostingKey ? stackOutputs[hostingKey] : '';
    if (!hostingUrl) throw new Error('HostingHostingUrl* not found in stack outputs: ' + JSON.stringify(stackOutputs));
    if (!hostingUrl.startsWith('http')) hostingUrl = `https://${hostingUrl}`;
    console.log(`\n✅ Deployed at: ${hostingUrl}\n`);

    testSupportSecret = await readTestSupportSecret(stackOutputs);
  } else {
    hostingUrl = process.env.HOSTING_URL || 'http://localhost:3000';
  }
});

// Teardown: `globalTeardown` (test/global-teardown.ts) destroys the stack once, after all tests and retries.

/**
 * Read the stack's test-support secret: a random SSM SecureString the stack
 * generates at deploy, named by the `TestSupportSecretParameter` output. See
 * "Sandbox e2e test support" in `aws-blocks/index.ts`.
 */
async function readTestSupportSecret(stackOutputs: Record<string, string>): Promise<string> {
  const key = Object.keys(stackOutputs).find(k => k.startsWith('TestSupportSecretParameter'));
  if (!key) throw new Error('TestSupportSecretParameter* not found in stack outputs: ' + JSON.stringify(stackOutputs));
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  const out = await new SSMClient({}).send(new GetParameterCommand({ Name: stackOutputs[key], WithDecryption: true }));
  if (!out.Parameter?.Value) throw new Error(`SSM parameter ${stackOutputs[key]} has no value`);
  return out.Parameter.Value;
}

/** Call `testSupport.provisionUser` and return the raw JSON-RPC response body. */
async function callProvisionUser(request: APIRequestContext, secret: string, username: string, password: string) {
  const resp = await request.post(`${hostingUrl}/aws-blocks/api`, {
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({
      jsonrpc: '2.0',
      method: 'testSupport.provisionUser',
      params: [secret, username, password],
      id: 1,
    }),
  });
  return await resp.json();
}

/**
 * Create a confirmed user through the backend's `testSupport.provisionUser`
 * RPC (sandbox only — see `aws-blocks/index.ts`).
 */
async function provisionUser(request: APIRequestContext, username: string, password: string) {
  const body = await callProvisionUser(request, testSupportSecret, username, password);
  expect(body.result).toEqual({ success: true });
}

// ── Full User Journey ──────────────────────────────────────────────────────

test.describe('Notes Manager — SPA Hosting', () => {
  test.describe.configure({ mode: 'serial' });

  const testUser = `e2e-${Date.now()}@example.com`;
  const testPassword = 'TestPass123!';

  test('1. Landing page shows public stats', async ({ page }) => {
    await page.goto(hostingUrl);
    await expect(page.locator('#app-status')).toHaveText('Ready');
    await expect(page.locator('#stat-total')).not.toHaveText('...');
  });

  test('2. config.json is served with apiUrl', async ({ request }) => {
    const resp = await request.get(`${hostingUrl}/.blocks-sandbox/config.json`);
    expect(resp.status()).toBe(200);
    const config = await resp.json();
    expect(config.apiUrl).toBeTruthy();
    expect(config.apiUrl).toBe('/aws-blocks/api');
  });

  test('3. SPA fallback — deep path still loads the app', async ({ page }) => {
    const resp = await page.goto(`${hostingUrl}/some/deep/path`);
    expect(resp?.status()).toBe(200);
    await expect(page.locator('h1')).toContainText('Notes Manager');
  });

  test('4. Sign up → confirm → login → dashboard', async ({ page, request }) => {
    await page.goto(hostingUrl);
    await expect(page.locator('#app-status')).toHaveText('Ready');

    if (ENV === 'sandbox') {
      // Cognito emails the sign-up code and this run has no mailbox to read it
      // from, so the deployed run provisions a confirmed user instead. The
      // local run below covers the sign-up form and the emailed-code step.
      await provisionUser(request, testUser, testPassword);
      await page.fill('#login-username', testUser);
      await page.fill('#login-password', testPassword);
    } else {
      // Sign up
      await page.fill('#login-username', testUser);
      await page.fill('#login-password', testPassword);
      await page.click('#btn-signup');
      await expect(page.locator('#auth-info')).toContainText('Account created');
      await expect(page.locator('#confirm-section')).toBeVisible();

      // Confirm (code auto-filled by test shortcut)
      await page.click('#btn-confirm');
      await expect(page.locator('#auth-info')).toContainText('Confirmed');
    }

    // Login
    await page.click('#btn-login');
    await expect(page.locator('#view-dashboard')).toBeVisible();
    await expect(page.locator('#display-username')).toHaveText(testUser);

    // Empty dashboard
    await expect(page.locator('#notes-empty')).toBeVisible();
    await expect(page.locator('#notes-empty')).toContainText('No notes yet');
  });

  test('4b. authGetLastCode is keyed per-user', async ({ request }) => {
    // The deployed run provisions its user instead of signing up (Cognito emails
    // the code and the mock-only hook never runs), so there is no code to read.
    test.skip(ENV === 'sandbox', 'no delivered code on AWS: test 4 provisions the user');
    // Pins the contract this fix introduces: the delivered-code read is scoped
    // to the username, so a code is never returned for a user who never signed
    // up, and the record returned belongs to the user asked for. Called over
    // JSON-RPC directly — testUser signed up in the previous serial test.
    const rpc = async (method: string, args: unknown[]) => {
      const resp = await request.post(`${hostingUrl}/aws-blocks/api`, {
        headers: { 'Content-Type': 'application/json' },
        data: { jsonrpc: '2.0', method: `api.${method}`, params: args, id: 1 },
      });
      expect(resp.ok()).toBeTruthy();
      return (await resp.json()).result;
    };

    expect(await rpc('authGetLastCode', ['never-signed-up@example.com'])).toBeNull();

    const mine = await rpc('authGetLastCode', [testUser]);
    expect(mine?.username).toBe(testUser);
  });

  test('5. Create first note "Shopping List"', async ({ page }) => {
    await page.goto(hostingUrl);
    await expect(page.locator('#app-status')).toHaveText('Ready');
    await page.fill('#login-username', testUser);
    await page.fill('#login-password', testPassword);
    await page.click('#btn-login');
    await expect(page.locator('#view-dashboard')).toBeVisible();

    await page.fill('#note-title', 'Shopping List');
    await page.fill('#note-content', 'Milk, Eggs, Bread');
    await page.click('#btn-create');

    await expect(page.locator('[data-testid="note-item"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="note-item"]').first()).toContainText('Shopping List');
    await expect(page.locator('[data-testid="note-item"]').first()).toContainText('Milk, Eggs, Bread');
  });

  test('6. Create second note "Work Tasks" — both visible', async ({ page }) => {
    await page.goto(hostingUrl);
    await page.fill('#login-username', testUser);
    await page.fill('#login-password', testPassword);
    await page.click('#btn-login');
    await expect(page.locator('#view-dashboard')).toBeVisible();

    // First note should already be there
    await expect(page.locator('[data-testid="note-item"]')).toHaveCount(1);

    await page.fill('#note-title', 'Work Tasks');
    await page.fill('#note-content', 'Fix bug, Write tests');
    await page.click('#btn-create');

    await expect(page.locator('[data-testid="note-item"]')).toHaveCount(2);
  });

  test('7. Refresh page — notes persist', async ({ page }) => {
    await page.goto(hostingUrl);
    await page.fill('#login-username', testUser);
    await page.fill('#login-password', testPassword);
    await page.click('#btn-login');
    await expect(page.locator('#view-dashboard')).toBeVisible();

    // Both notes should still be there after fresh page load + login
    await expect(page.locator('[data-testid="note-item"]')).toHaveCount(2);
    await expect(page.locator('#notes-list')).toContainText('Shopping List');
    await expect(page.locator('#notes-list')).toContainText('Work Tasks');
  });

  test('8. Delete "Shopping List" — only "Work Tasks" remains', async ({ page }) => {
    await page.goto(hostingUrl);
    await page.fill('#login-username', testUser);
    await page.fill('#login-password', testPassword);
    await page.click('#btn-login');
    await expect(page.locator('#view-dashboard')).toBeVisible();
    await expect(page.locator('[data-testid="note-item"]')).toHaveCount(2);

    // Find and delete "Shopping List"
    const shoppingNote = page.locator('[data-testid="note-item"]', { hasText: 'Shopping List' });
    await shoppingNote.locator('[data-testid="btn-delete"]').click();

    await expect(page.locator('[data-testid="note-item"]')).toHaveCount(1);
    await expect(page.locator('#notes-list')).toContainText('Work Tasks');
    await expect(page.locator('#notes-list')).not.toContainText('Shopping List');
  });

  test('9. Logout → landing page, login again → "Work Tasks" persists', async ({ page }) => {
    await page.goto(hostingUrl);
    await page.fill('#login-username', testUser);
    await page.fill('#login-password', testPassword);
    await page.click('#btn-login');
    await expect(page.locator('#view-dashboard')).toBeVisible();

    // Logout
    await page.click('#btn-logout');
    await expect(page.locator('#view-landing')).toBeVisible();

    // Login again
    await page.fill('#login-username', testUser);
    await page.fill('#login-password', testPassword);
    await page.click('#btn-login');
    await expect(page.locator('#view-dashboard')).toBeVisible();

    // Work Tasks should still be there
    await expect(page.locator('[data-testid="note-item"]')).toHaveCount(1);
    await expect(page.locator('#notes-list')).toContainText('Work Tasks');
  });

  test('10. Public stats reflect note count', async ({ page }) => {
    await page.goto(hostingUrl);
    await expect(page.locator('#app-status')).toHaveText('Ready');
    const statsLocator = page.locator('#stat-total');
    await expect(statsLocator).not.toHaveText('...');
    await expect(statsLocator).not.toHaveText('0');
    await expect(statsLocator).toHaveText(/^[1-9]\d*$/);
  });
});

// `testSupport.provisionUser` creates accounts, so it must not exist on a normal
// build (local dev included), and on the sandbox e2e build it must refuse a
// caller without the deploy's secret.
test.describe('Test support endpoint is gated', () => {
  test('absent from a normal build; refuses a wrong secret on the e2e build', async ({ request }) => {
    const body = await callProvisionUser(request, 'not-the-secret', `e2e-gate-${Date.now()}@example.com`, 'TestPass123!');
    expect(body.result).toBeUndefined();
    expect(body.error.code).toBe(ENV === 'sandbox' ? 403 : -32601);
  });
});
