// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Wait until React has hydrated the current document. Every interactive control in this app
 * is server-rendered, so it is visible (and "actionable" to `click()` / `fill()`) before React
 * attaches its handlers. `page.goto()` and `waitForURL()` return at `load`, which does not
 * guarantee hydration has run, and an interaction that lands before it is silently lost: a
 * click does nothing, and a value typed into a controlled input never reaches React state.
 * The root layout's `HydrationMarker` sets `data-hydrated` on `<html>` from a `useEffect`,
 * which runs only once hydration has committed.
 */
async function waitForHydration(page: Page, opts?: { timeout?: number }) {
  await page.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', null, {
    timeout: opts?.timeout ?? 15_000,
  });
}

/** Navigate to a page and wait for React hydration before the test interacts with it. */
async function gotoHydrated(page: Page, url: string, opts?: { timeout?: number }) {
  await page.goto(url);
  await waitForHydration(page, opts);
}

/**
 * Read the stack's test-support secret: a random SSM SecureString the stack
 * generates at deploy, named by the `TestSupportSecretParameter` output. See
 * "Sandbox e2e test support" in `aws-blocks/index.ts`.
 */
async function readTestSupportSecret(stackOutputs: Record<string, string>): Promise<string> {
  const key = Object.keys(stackOutputs).find((k) => k.startsWith('TestSupportSecretParameter'));
  if (!key) throw new Error(`TestSupportSecretParameter* not found in stack outputs: ${JSON.stringify(stackOutputs)}`);
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  const out = await new SSMClient({}).send(new GetParameterCommand({ Name: stackOutputs[key], WithDecryption: true }));
  if (!out.Parameter?.Value) throw new Error(`SSM parameter ${stackOutputs[key]} has no value`);
  return out.Parameter.Value;
}

/** Call `testSupport.provisionUser` and return the raw JSON-RPC response body. */
async function callProvisionUser(
  request: APIRequestContext,
  baseUrl: string,
  secret: string,
  username: string,
  password: string,
) {
  const resp = await request.post(`${baseUrl}/aws-blocks/api`, {
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

/** The deployed stack's test-support secret (sandbox only). Never log it. */
let testSupportSecret = '';

/**
 * Create a confirmed user through the backend's `testSupport.provisionUser`
 * RPC (sandbox only — see `aws-blocks/index.ts`). Cognito emails the sign-up
 * code and a deployed run has no mailbox to read it from.
 */
async function provisionUser(request: APIRequestContext, baseUrl: string, username: string, password: string) {
  const body = await callProvisionUser(request, baseUrl, testSupportSecret, username, password);
  expect(body.result).toEqual({ success: true });
}

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

let hostingUrl: string;
let buildCacheBucketName: string;

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
    testSupportSecret = await readTestSupportSecret(stackOutputs);

    console.log(`\n✅ Deployed at: ${hostingUrl}\n`);

    // Build cache bucket output
    const bucketKey = Object.keys(stackOutputs).find(k => k.startsWith('HostingBuildCacheBucketName'));
    buildCacheBucketName = bucketKey ? stackOutputs[bucketKey] : '';
  } else {
    hostingUrl = process.env.HOSTING_URL || 'http://localhost:3000';
  }
});

// Teardown: `globalTeardown` (test/global-teardown.ts) destroys the stack once, after all tests and retries.

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

  test('3. Sign up + confirm + login', async ({ page, request }) => {
    await gotoHydrated(page, `${hostingUrl}/login`);

    if (ENV === 'sandbox') {
      // No mailbox for the emailed sign-up code: provision a confirmed user.
      // The local run covers the sign-up form and the code step.
      await provisionUser(request, hostingUrl, testUser, testPassword);
      await page.fill('#login-username', testUser);
      await page.fill('#login-password', testPassword);
    } else {
      // Sign up
      await page.fill('#login-username', testUser);
      await page.fill('#login-password', testPassword);
      await page.click('#btn-signup');
      await expect(page.locator('#auth-info')).toContainText('Account created');
      await expect(page.locator('#confirm-section')).toBeVisible();

      // Confirm
      await page.click('#btn-confirm');
      await expect(page.locator('#auth-info')).toContainText('Confirmed');
    }

    // Login → redirects to dashboard
    await page.click('#btn-login');
    await page.waitForURL('**/dashboard');
  });

  test('4. Dashboard SSR shows empty state (proves cookie forwarding)', async ({ page }) => {
    // Login first
    await gotoHydrated(page, `${hostingUrl}/login`);
    await page.fill('#login-username', testUser);
    await page.fill('#login-password', testPassword);
    await page.click('#btn-login');
    await page.waitForURL('**/dashboard');

    // Verify SSR-rendered dashboard with auth
    await expect(page.locator('[data-testid="dashboard-user"]')).toContainText(testUser);
    await expect(page.locator('[data-testid="no-posts"]')).toBeVisible();
  });

  test('5. Create a post "Hello World"', async ({ page }) => {
    await gotoHydrated(page, `${hostingUrl}/login`);
    await page.fill('#login-username', testUser);
    await page.fill('#login-password', testPassword);
    await page.click('#btn-login');
    await page.waitForURL('**/dashboard');

    await gotoHydrated(page, `${hostingUrl}/create`);
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
    await gotoHydrated(page, `${hostingUrl}/login`);
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
    await gotoHydrated(page, `${hostingUrl}/login`);
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
    await gotoHydrated(page, `${hostingUrl}/login`);
    await page.fill('#login-username', testUser);
    await page.fill('#login-password', testPassword);
    await page.click('#btn-login');
    await page.waitForURL('**/dashboard');
    // The delete button is server-rendered, so it is visible (and "actionable" to `click()`)
    // before React attaches its `onClick`. Wait for hydration, or the click does nothing.
    await waitForHydration(page);

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

test.describe('SSR cache isolation (per-session cache key)', () => {
  // /cache-isolation is an SSR route that echoes the `bb_session` cookie and
  // emits `Cache-Control: public, s-maxage=300`, so CloudFront caches it. The
  // app sets cdn.cacheKeyCookies=['bb_session'], putting the session cookie in
  // the CDN cache key — so each session keys a separate cache entry. Without
  // the cookie in the key, this s-maxage response would be a single shared
  // cache entry.

  test('each session cookie gets its own rendered body', async ({ request }) => {
    // Functional check that runs in every env (no CDN required): the route
    // renders per-session content, so distinct session cookies produce
    // distinct bodies.
    const isolationUrl = `${hostingUrl}/cache-isolation`;
    const userA = `alice-${randomBytes(6).toString('hex')}`;
    const userB = `bob-${randomBytes(6).toString('hex')}`;

    const a = await request.get(isolationUrl, { headers: { Cookie: `bb_session=${userA}` } });
    expect(a.status()).toBe(200);
    expect(await a.text()).toContain(`user=${userA}`);

    const b = await request.get(isolationUrl, { headers: { Cookie: `bb_session=${userB}` } });
    expect(b.status()).toBe(200);
    const bBody = await b.text();
    expect(bBody).toContain(`user=${userB}`);
    expect(bBody).not.toContain(userA);
  });

  test('per-session cache key: a warmed edge HIT for one session is not reused for a different session (sandbox)', async ({ request }) => {
    // Only CloudFront (in front only in sandbox) sets `x-cache: Hit from
    // cloudfront`; local/dev mode has no CDN and cannot exercise a real edge
    // HIT, so this per-session cache-key proof runs in sandbox only.
    if (ENV !== 'sandbox') {
      test.skip();
      return;
    }

    const isolationUrl = `${hostingUrl}/cache-isolation`;
    const userA = `alice-${randomBytes(6).toString('hex')}`;
    const userB = `bob-${randomBytes(6).toString('hex')}`;

    // Warm the edge for user A: the first request is a MISS that populates the
    // cache; a repeat is a HIT of A's body.
    const a1 = await request.get(isolationUrl, { headers: { Cookie: `bb_session=${userA}` } });
    expect(a1.status()).toBe(200);
    expect(await a1.text()).toContain(`user=${userA}`);

    const a2 = await request.get(isolationUrl, { headers: { Cookie: `bb_session=${userA}` } });
    expect(a2.status()).toBe(200);
    expect(await a2.text()).toContain(`user=${userA}`);

    // Confirm A's repeat was actually served from the CloudFront cache — a real
    // HIT is what makes the per-session check below meaningful (otherwise B
    // could pass simply by MISSing and rendering its own body).
    expect(a2.headers()['x-cache'] || '').toContain('Hit from cloudfront');

    // User B hits the SAME URL with a different session cookie. Because the
    // session cookie is in the cache key, B gets its own cache entry and its
    // own body, not A's warmed entry.
    const b1 = await request.get(isolationUrl, { headers: { Cookie: `bb_session=${userB}` } });
    expect(b1.status()).toBe(200);
    const bBody = await b1.text();
    expect(bBody).toContain(`user=${userB}`);
    expect(bBody).not.toContain(userA);
  });

  test('the isolation route is edge-cacheable (origin emits s-maxage)', async ({ request }) => {
    const isolationUrl = `${hostingUrl}/cache-isolation`;
    const resp = await request.get(isolationUrl, {
      headers: { Cookie: `bb_session=probe-${randomBytes(4).toString('hex')}` },
    });
    expect(resp.status()).toBe(200);
    // The origin's Cache-Control (honored by the SSR cache policy) makes the
    // response cacheable; if this were absent the isolation test above would
    // never exercise a cache entry.
    expect(resp.headers()['cache-control'] || '').toMatch(/s-maxage=300/);
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
    const { setSecret, setConfig, removeSecret, removeConfig } = await import('@aws-blocks/blocks/scripts');
    const demoSecret = `sk_e2e_${randomBytes(12).toString('hex')}`;
    const demoConfig = JSON.stringify({ beta: true, run: randomBytes(4).toString('hex') });

    try {
      await setSecret('DEMO_SECRET', demoSecret);
      await setConfig('DEMO_CONFIG', demoConfig);
    } catch (err) {
      // Some deploy roles (e.g. the CI GitHub Actions role) can provision infra
      // but are not permitted to WRITE the value stores (no
      // `secretsmanager:CreateSecret` / `ssm:PutParameter`). The write path and
      // the store→getSecret/getConfig resolution are already covered by the
      // hosting unit tests, so skip (don't fail) where the runner can't provision.
      const msg = err instanceof Error ? err.message : String(err);
      if (/AccessDenied|not authorized|AuthorizationError/i.test(msg)) {
        test.skip(true, `store write not permitted in this environment: ${msg}`);
        return;
      }
      throw err;
    }

    try {
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
    } finally {
      // The values are written out of band, so `destroy` won't remove them — clean
      // up here (best-effort; ignore if the role can't delete). Fixes the leak.
      await removeSecret('DEMO_SECRET').catch(() => {});
      await removeConfig('DEMO_CONFIG').catch(() => {});
    }
  });
});

// `testSupport.provisionUser` creates accounts, so it must not exist on a normal
// build (local dev included), and on the sandbox e2e build it must refuse a
// caller without the deploy's secret.
test.describe('Test support endpoint is gated', () => {
  test('absent from a normal build; refuses a wrong secret on the e2e build', async ({ request }) => {
    const user = `e2e-gate-${Date.now()}@example.com`;
    const body = await callProvisionUser(request, hostingUrl, 'not-the-secret', user, 'TestPass123!');
    expect(body.result).toBeUndefined();
    expect(body.error.code).toBe(ENV === 'sandbox' ? 403 : -32601);
  });
});
