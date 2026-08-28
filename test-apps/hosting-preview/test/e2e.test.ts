// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const backendPath = join(__dirname, '..', 'aws-blocks', 'index.cdk.ts');

let hostingUrl: string;

// ── Deploy / Teardown ──────────────────────────────────────────────────────

test.beforeAll(async () => {
  if (ENV === 'sandbox') {
    console.log('🚀 Deploying hosting-preview sandbox...\n');
    execFileSync('npx', ['tsx', 'test/sandbox-deploy.ts', backendPath], {
      cwd: projectRoot, stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '' },
    });

    const outputs = JSON.parse(readFileSync(join(projectRoot, '.blocks-sandbox', 'outputs.json'), 'utf-8'));
    const stackOutputs = Object.values(outputs)[0] as Record<string, string>;
    // CDK appends a hash suffix to output keys — find by prefix
    const hostingKey = Object.keys(stackOutputs).find(k => k.startsWith('HostingHostingUrl'));
    hostingUrl = hostingKey ? stackOutputs[hostingKey] : '';
    if (!hostingUrl) throw new Error('HostingHostingUrl* not found in stack outputs: ' + JSON.stringify(stackOutputs));
    if (!hostingUrl.startsWith('http')) hostingUrl = `https://${hostingUrl}`;
    console.log(`\n✅ Deployed at: ${hostingUrl}\n`);
  } else {
    hostingUrl = process.env.HOSTING_URL || 'http://localhost:3000';
  }
});

test.afterAll(async () => {
  if (ENV === 'sandbox' && !process.env.BLOCKS_SANDBOX_KEEP) {
    console.log('\n🗑️  Destroying sandbox...');
    execFileSync('npx', ['tsx', 'test/sandbox-destroy.ts', backendPath], {
      cwd: projectRoot, stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
  }
});

// ── Full User Journey ──────────────────────────────────────────────────────

test.describe('Notes Manager — Preview mode (fully enabled)', () => {
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

  test('4. Sign up → confirm → login → dashboard', async ({ page }) => {
    await page.goto(hostingUrl);
    await expect(page.locator('#app-status')).toHaveText('Ready');

    // Sign up
    await page.fill('#login-username', testUser);
    await page.fill('#login-password', testPassword);
    await page.click('#btn-signup');
    await expect(page.locator('#auth-info')).toContainText('Account created');
    await expect(page.locator('#confirm-section')).toBeVisible();

    // Confirm (code auto-filled by test shortcut)
    await page.click('#btn-confirm');
    await expect(page.locator('#auth-info')).toContainText('Confirmed');

    // Login
    await page.click('#btn-login');
    await expect(page.locator('#view-dashboard')).toBeVisible();
    await expect(page.locator('#display-username')).toHaveText(testUser);

    // Empty dashboard
    await expect(page.locator('#notes-empty')).toBeVisible();
    await expect(page.locator('#notes-empty')).toContainText('No notes yet');
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
