// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const backendPath = join(__dirname, '..', 'aws-blocks', 'index.cdk.ts');

let hostingUrl: string;
let buildCacheBucketName: string;

// ── Deploy / Teardown ──────────────────────────────────────────────────────

test.beforeAll(async () => {
  if (ENV === 'sandbox') {
    console.log('🚀 Deploying hosting-ssr sandbox...\n');
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

    // Build cache bucket output
    const bucketKey = Object.keys(stackOutputs).find(k => k.startsWith('HostingBuildCacheBucketName'));
    buildCacheBucketName = bucketKey ? stackOutputs[bucketKey] : '';
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

test.describe('Blog with Auth — SSR Hosting', () => {
  test.describe.configure({ mode: 'serial' });

  const testUser = `e2e-ssr-${Date.now()}@example.com`;
  const testPassword = 'TestPass123!';

  test('1. Homepage is server-rendered with post list', async ({ page, request }) => {
    // Fetch raw HTML — proves SSR (no JS execution)
    const rawResp = await request.get(hostingUrl);
    const html = await rawResp.text();
    expect(html).toContain('Server-rendered blog posts');
    expect(html).toContain('data-testid="ssr-home-marker"');

    // Also verify via Playwright
    await page.goto(hostingUrl);
    await expect(page.locator('[data-testid="ssr-home-marker"]')).toHaveText('Server-rendered blog posts');
  });

  test('2. config.json is served with apiUrl', async ({ request }) => {
    const resp = await request.get(`${hostingUrl}/.blocks-sandbox/config.json`);
    expect(resp.status()).toBe(200);
    const config = await resp.json();
    expect(config.apiUrl).toBeTruthy();
    // Local dev uses http://localhost:PORT/aws-blocks/api, production uses relative /aws-blocks/api
    if (ENV === 'local') {
      expect(config.apiUrl).toContain('/aws-blocks/api');
    } else {
      expect(config.apiUrl).toBe('/aws-blocks/api');
    }
  });

  test('3. Sign up + confirm + login', async ({ page }) => {
    await page.goto(`${hostingUrl}/login`);

    // Sign up
    await page.fill('#login-username', testUser);
    await page.fill('#login-password', testPassword);
    await page.click('#btn-signup');
    await expect(page.locator('#auth-info')).toContainText('Account created');
    await expect(page.locator('#confirm-section')).toBeVisible();

    // Confirm
    await page.click('#btn-confirm');
    await expect(page.locator('#auth-info')).toContainText('Confirmed');

    // Login → redirects to dashboard
    await page.click('#btn-login');
    await page.waitForURL('**/dashboard');
  });

  test('4. Dashboard SSR shows empty state (proves cookie forwarding)', async ({ page }) => {
    // Login first
    await page.goto(`${hostingUrl}/login`);
    await page.fill('#login-username', testUser);
    await page.fill('#login-password', testPassword);
    await page.click('#btn-login');
    await page.waitForURL('**/dashboard');

    // Verify SSR-rendered dashboard with auth
    await expect(page.locator('[data-testid="dashboard-user"]')).toContainText(testUser);
    await expect(page.locator('[data-testid="no-posts"]')).toBeVisible();
  });

  test('5. Create a post "Hello World"', async ({ page }) => {
    await page.goto(`${hostingUrl}/login`);
    await page.fill('#login-username', testUser);
    await page.fill('#login-password', testPassword);
    await page.click('#btn-login');
    await page.waitForURL('**/dashboard');

    await page.goto(`${hostingUrl}/create`);
    await page.fill('#post-title', 'Hello World');
    await page.fill('#post-body', 'My first blog post from the SSR e2e test!');
    await page.click('#btn-publish');
    await page.waitForURL('**/dashboard');

    // Post should appear in dashboard
    await expect(page.locator('[data-testid="my-post-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="my-posts"]')).toContainText('Hello World');
  });

  test('6. Dashboard SSR shows the post (auth-protected SSR)', async ({ page, request }) => {
    // Login
    await page.goto(`${hostingUrl}/login`);
    await page.fill('#login-username', testUser);
    await page.fill('#login-password', testPassword);
    await page.click('#btn-login');
    await page.waitForURL('**/dashboard');

    // Verify post is in the SSR-rendered HTML
    await expect(page.locator('[data-testid="my-posts"]')).toContainText('Hello World');

    // Get cookies from browser context to verify SSR
    const cookies = await page.context().cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Fetch raw dashboard HTML with cookies to prove SSR
    const rawResp = await request.get(`${hostingUrl}/dashboard`, {
      headers: { Cookie: cookieStr },
    });
    const html = await rawResp.text();
    expect(html).toContain('Hello World');
    expect(html).toContain(testUser);
  });

  test('7. Homepage shows "Hello World" in public list (SSR)', async ({ page, request }) => {
    await page.goto(hostingUrl);
    await expect(page.locator('[data-testid="post-list"]')).toContainText('Hello World');

    // SSR proof: raw HTML contains the post
    const rawResp = await request.get(hostingUrl);
    const html = await rawResp.text();
    expect(html).toContain('Hello World');
  });

  test('8. Post detail page is server-rendered', async ({ page, request }) => {
    // Get the post ID from the homepage link
    await page.goto(hostingUrl);
    const postLink = page.locator('[data-testid="post-card"] a').first();
    const href = await postLink.getAttribute('href');
    expect(href).toBeTruthy();

    // SSR proof: raw HTML has the content
    const rawResp = await request.get(`${hostingUrl}${href}`);
    const html = await rawResp.text();
    expect(html).toContain('Hello World');
    expect(html).toContain('My first blog post from the SSR e2e test!');

    // Also verify via Playwright
    await page.goto(`${hostingUrl}${href}`);
    await expect(page.locator('[data-testid="post-title"]')).toHaveText('Hello World');
    await expect(page.locator('[data-testid="post-body"]')).toContainText('My first blog post');
  });

  test('9. Profile page is server-rendered with user data (cookie forwarding proof)', async ({ page, request }) => {
    // Login
    await page.goto(`${hostingUrl}/login`);
    await page.fill('#login-username', testUser);
    await page.fill('#login-password', testPassword);
    await page.click('#btn-login');
    await page.waitForURL('**/dashboard');

    // Visit profile
    await page.goto(`${hostingUrl}/profile`);
    await expect(page.locator('[data-testid="profile-username"]')).toHaveText(testUser);
    await expect(page.locator('[data-testid="profile-post-count"]')).toHaveText('1');

    // SSR proof: raw HTML contains user data
    const cookies = await page.context().cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const rawResp = await request.get(`${hostingUrl}/profile`, {
      headers: { Cookie: cookieStr },
    });
    const html = await rawResp.text();
    expect(html).toContain(testUser);
    expect(html).toContain('data-testid="profile-username"');
  });

  test('10. Delete post from dashboard', async ({ page }) => {
    await page.goto(`${hostingUrl}/login`);
    await page.fill('#login-username', testUser);
    await page.fill('#login-password', testPassword);
    await page.click('#btn-login');
    await page.waitForURL('**/dashboard');

    await expect(page.locator('[data-testid="my-post-card"]')).toHaveCount(1);
    await page.locator('[data-testid="btn-delete"]').first().click();

    // After page reload, no posts
    await page.waitForURL('**/dashboard');
    await expect(page.locator('[data-testid="no-posts"]')).toBeVisible();
  });

  test('11. Homepage no longer shows deleted post (SSR)', async ({ request }) => {
    const rawResp = await request.get(hostingUrl);
    const html = await rawResp.text();
    expect(html).not.toContain('Hello World');
    expect(html).toContain('No posts yet');
  });

  test('12. Unauthenticated /dashboard redirects to /login', async ({ page }) => {
    // Fresh context, no cookies
    const context = await page.context().browser()!.newContext();
    const freshPage = await context.newPage();
    await freshPage.goto(`${hostingUrl}/dashboard`);
    await freshPage.waitForURL('**/login');
    await context.close();
  });

  test('13. Non-existent post returns 404', async ({ page }) => {
    const resp = await page.goto(`${hostingUrl}/posts/nonexistent-12345`);
    expect(resp?.status()).toBe(404);
  });
});

test.describe('SSR origin regression coverage', () => {
  test('POST /api/probe/echo returns body intact', async ({ request }) => {
    const payload = { hello: 'world', n: 42 };
    const resp = await request.post(`${hostingUrl}/api/probe/echo`, { data: payload });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.method).toBe('POST');
    expect(body.body).toEqual(payload);
  });

  test('PUT /api/probe/echo returns body intact', async ({ request }) => {
    const resp = await request.put(`${hostingUrl}/api/probe/echo`, {
      data: { updated: true },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.method).toBe('PUT');
    expect(body.body).toEqual({ updated: true });
  });

  test('DELETE /api/probe/echo?id=42 succeeds', async ({ request }) => {
    const resp = await request.delete(`${hostingUrl}/api/probe/echo?id=42`);
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.method).toBe('DELETE');
    expect(body.query).toEqual({ id: '42' });
  });

  test('Multi Set-Cookie not collapsed by CloudFront/APIGW', async ({ request }) => {
    const resp = await request.get(`${hostingUrl}/api/probe/cookies`);
    expect(resp.status()).toBe(200);
    const setCookies = resp.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
    expect(setCookies).toHaveLength(3);
    expect(setCookies.map((h) => h.value).join('|')).toMatch(/stress-a=1/);
    expect(setCookies.map((h) => h.value).join('|')).toMatch(/stress-b=2/);
    expect(setCookies.map((h) => h.value).join('|')).toMatch(/stress-c=3/);
  });

  test('Binary body integrity (1 MB random POST round-trips with same sha256)', async ({
    request,
  }) => {
    const buf = randomBytes(1 * 1024 * 1024);
    const expectedSha = createHash('sha256').update(buf).digest('hex');

    const resp = await request.post(`${hostingUrl}/api/probe/upload`, {
      data: buf,
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.bytes).toBe(buf.length);
    expect(body.sha256).toBe(expectedSha);
  });

  test('Streaming response: all 5 chunks delivered with realistic latency', async ({
    request,
  }) => {
    // The handler emits 5 chunks 200ms apart, so an honest end-to-end response
    // can't complete in much less than 800ms. We don't measure TTFB here:
    // Playwright's APIRequestContext awaits the full body before resolving,
    // so ttfb ≈ total by construction even when the Lambda truly streams.
    const isLocal = ENV === 'local';

    const start = Date.now();
    const resp = await request.get(`${hostingUrl}/api/probe/stream`);
    expect(resp.status()).toBe(200);

    const text = await resp.text();
    const total = Date.now() - start;

    for (let i = 0; i < 5; i++) {
      expect(text).toContain(`chunk ${i}`);
    }

    if (!isLocal) {
      expect(total).toBeGreaterThanOrEqual(800);
    }
  });
});

test.describe('Build cache infrastructure', () => {
  test('BuildCacheBucketName output exists when deployed', async () => {
    if (ENV !== 'sandbox') {
      test.skip();
      return;
    }
    expect(buildCacheBucketName).toBeTruthy();
    expect(buildCacheBucketName).toMatch(/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/);
  });
});

// Sandbox-only: the mock/local path (env-first resolution) is covered by the
// hosting unit tests; this asserts the real AWS path — secret() resolves from
// Secrets Manager and config() from SSM, each from its own store, via the exact
// CLI-write → IAM-grant → getSecret/getConfig-read flow a customer would use.
test.describe('Secrets & config (secret() → Secrets Manager, config() → SSM)', () => {
  const sha8 = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 8);

  test('resolves each value at runtime from its own store', async ({ request }) => {
    if (ENV !== 'sandbox') {
      test.skip();
      return;
    }

    // Write both values out of band via the shipped CLI helpers (same code path
    // as `npm run secret -- set` / `npm run config -- set`, region from AWS_REGION).
    const { setSecret, setConfig } = await import('@aws-blocks/blocks/scripts');
    const demoSecret = `sk_e2e_${randomBytes(12).toString('hex')}`;
    const demoConfig = JSON.stringify({ beta: true, run: randomBytes(4).toString('hex') });
    await setSecret('DEMO_SECRET', demoSecret);
    await setConfig('DEMO_CONFIG', demoConfig);

    const resp = await request.get(`${hostingUrl}/api/probe/secret`);
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);

    // secret() → Secrets Manager: fingerprint matches; the raw value is never echoed.
    expect(body.secret).toEqual({ len: demoSecret.length, sha8: sha8(demoSecret) });
    expect(JSON.stringify(body)).not.toContain(demoSecret);

    // config() → SSM: resolved to the exact value the CLI wrote (non-sensitive, echoed).
    expect(body.config.value).toBe(demoConfig);
    expect(body.config.sha8).toBe(sha8(demoConfig));
  });
});
