// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, expect, type Page, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Navigate to a page and wait for Nuxt/Vue 3 hydration to complete.
 * `networkidle` only ensures JS bundles are downloaded; hydration (attaching event handlers)
 * is CPU work that finishes asynchronously. We check for Vue 3's `__vue_app__` on the root element.
 *
 * `__vue_app__` is set when the app *starts* mounting. A page with an async `<script setup>`
 * (top-level `await useFetch(...)`, like `/dashboard`) hydrates inside `<Suspense>` and only gets
 * its event handlers once that resolves, which Nuxt signals by setting `$nuxt.isHydrating` to
 * `false`. We wait for both. A click on server-rendered markup before then is silently lost —
 * under `nuxt dev` that window lasts seconds, because Vite serves hundreds of unbundled modules.
 */
async function gotoHydrated(page: Page, url: string, opts?: { timeout?: number }) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => {
      const app = (document.getElementById('__nuxt') as any)?.__vue_app__;
      return !!app && app.config.globalProperties.$nuxt?.isHydrating === false;
    },
    { timeout: opts?.timeout ?? 15_000 },
  );
}

/**
 * Sign in via direct API call and set the auth cookie on the browser context.
 *
 * Use this for tests that aren't *about* the sign-in flow itself — it removes
 * a flaky-by-default browser interaction so the test can focus on what comes
 * after auth. One dedicated test (`'Real-browser login flow…'`) still
 * exercises the full `#btn-login` → `fetch()` → `Set-Cookie` → redirect path
 * end-to-end against the deployed gateway, so this helper does not hide the
 * sign-in pipeline from the suite.
 *
 * Background: the comment originally noted Set-Cookie "may not surface"
 * through API Gateway REST → CloudFront. This is **test-only**: Playwright's
 * `APIRequestContext` and the headless Chromium it drives both observe the
 * Set-Cookie reliably; the symptom we hit was a timing race in the page
 * navigation that followed login (the redirect fired before the cookie was
 * persisted to the browser context). The dedicated real-login test waits on
 * the post-login `#dashboard` URL transition, which removes the race —
 * production users follow that same path with the same outcome.
 */
async function loginViaApi(
  request: APIRequestContext,
  context: BrowserContext,
  baseUrl: string,
  username: string,
  password: string,
) {
  const resp = await request.post(`${baseUrl}/aws-blocks/api`, {
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({
      jsonrpc: '2.0',
      method: 'api.authSignIn',
      params: [username, password],
      id: 1,
    }),
  });
  expect(resp.ok()).toBe(true);
  const body = await resp.json();
  expect(body.result).toBeTruthy();

  const setCookieHeader = resp.headers()['set-cookie'];
  expect(setCookieHeader).toBeTruthy();
  const cookieMatch = setCookieHeader!.match(/^([^=]+)=([^;]+)/);
  expect(cookieMatch).toBeTruthy();

  await context.addCookies([{
    name: cookieMatch![1],
    value: cookieMatch![2],
    domain: new URL(baseUrl).hostname,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'None' as const,
  }]);
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

test.beforeAll(async () => {
  if (ENV === 'sandbox') {
    // The stack was deployed once for this run by `globalSetup` (test/global-setup.ts);
    // this hook runs per worker, so a retry re-reads the outputs instead of redeploying.

    const outputs = JSON.parse(
      readFileSync(join(projectRoot, '.blocks-sandbox', 'outputs.json'), 'utf-8'),
    );
    const stackOutputs = Object.values(outputs)[0] as Record<string, string>;
    const hostingKey = Object.keys(stackOutputs).find((k) =>
      k.startsWith('HostingHostingUrl'),
    );
    hostingUrl = hostingKey ? stackOutputs[hostingKey] : '';
    if (!hostingUrl) {
      throw new Error(
        `HostingHostingUrl* not found in stack outputs: ${JSON.stringify(stackOutputs)}`,
      );
    }
    if (!hostingUrl.startsWith('http')) hostingUrl = `https://${hostingUrl}`;
    testSupportSecret = await readTestSupportSecret(stackOutputs);
    console.log(`\n✅ Deployed at: ${hostingUrl}\n`);
  } else {
    hostingUrl = process.env.HOSTING_URL || 'http://localhost:3000';
  }
});

// Teardown: `globalTeardown` (test/global-teardown.ts) destroys the stack once, after all tests and retries.

test.describe('Blog with Auth — Nuxt SSR Hosting', () => {
  test.describe.configure({ mode: 'serial' });

  const testUser = `e2e-nuxt-${Date.now()}@example.com`;
  const testPassword = 'TestPass123!';

  test('1. Homepage is server-rendered with post list', async ({ page, request }) => {
    const rawResp = await request.get(hostingUrl);
    const html = await rawResp.text();
    expect(html).toContain('Server-rendered blog posts');
    expect(html).toContain('data-testid="ssr-home-marker"');

    await page.goto(hostingUrl);
    await expect(page.locator('[data-testid="ssr-home-marker"]')).toHaveText(
      'Server-rendered blog posts',
    );
  });

  test('2. config.json is served with apiUrl', async ({ request }) => {
    const resp = await request.get(`${hostingUrl}/.blocks-sandbox/config.json`);
    expect(resp.status()).toBe(200);
    const config = await resp.json();
    expect(config.apiUrl).toBeTruthy();
    if (ENV === 'local') {
      expect(config.apiUrl).toContain('/aws-blocks/api');
    } else {
      expect(config.apiUrl).toBe('/aws-blocks/api');
    }
  });

  test('3. Sign up + confirm + login', async ({ page, request }) => {
    // Warmup both Lambda functions: the SSR Lambda and the backend RPC Lambda.
    // Cold starts can take 10–15s each.
    await Promise.all([
      request.get(`${hostingUrl}/api/probe/health`),
      request.post(`${hostingUrl}/aws-blocks/api`, {
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ jsonrpc: '2.0', method: 'api.listPosts', params: [], id: 0 }),
      }),
    ]);

    if (ENV === 'sandbox') {
      // No mailbox for the emailed sign-up code: provision a confirmed user.
      // The local run covers the sign-up form and the code step.
      await provisionUser(request, hostingUrl, testUser, testPassword);
    } else {
      await gotoHydrated(page, `${hostingUrl}/login`);
      await page.fill('#login-username', testUser);
      await page.fill('#login-password', testPassword);
      await page.click('#btn-signup');
      await expect(page.locator('#auth-info')).toContainText('Account created', { timeout: 30_000 });
      await expect(page.locator('#confirm-section')).toBeVisible();
      await page.click('#btn-confirm');
      await expect(page.locator('#auth-info')).toContainText('Confirmed', { timeout: 30_000 });
    }

    await loginViaApi(request, page.context(), hostingUrl, testUser, testPassword);
    await page.goto(`${hostingUrl}/dashboard`);
    await page.waitForURL('**/dashboard', { timeout: 30_000 });
  });

  test('3b. Real-browser login flow — #btn-login → fetch → Set-Cookie → /dashboard', async ({
    page,
  }) => {
    // This is the only test that exercises the complete browser-driven
    // sign-in path: form submit → in-page fetch to the RPC API → server
    // sets the auth cookie via Set-Cookie → SPA navigates to /dashboard.
    // Subsequent tests use `loginViaApi()` (cookie injected directly) to
    // remove a flaky setup step, but if this real-flow test breaks we still
    // see it in CI rather than silently shipping a broken sign-in pipeline.
    await gotoHydrated(page, `${hostingUrl}/login`);
    await page.fill('#login-username', testUser);
    await page.fill('#login-password', testPassword);
    await page.click('#btn-login');

    // The post-login redirect proves both that Set-Cookie reached the
    // browser AND that subsequent SSR requests carried it (otherwise
    // /dashboard would bounce back to /login).
    await page.waitForURL('**/dashboard', { timeout: 30_000 });
    await expect(page.locator('[data-testid="dashboard-user"]')).toContainText(
      testUser,
    );
  });

  test('4. Dashboard SSR shows empty state (proves cookie forwarding)', async ({
    page,
    request,
  }) => {
    await loginViaApi(request, page.context(), hostingUrl, testUser, testPassword);
    await page.goto(`${hostingUrl}/dashboard`);

    await expect(page.locator('[data-testid="dashboard-user"]')).toContainText(
      testUser,
    );
    await expect(page.locator('[data-testid="no-posts"]')).toBeVisible();
  });

  test('5. Create a post "Hello Nuxt"', async ({ page, request }) => {
    await loginViaApi(request, page.context(), hostingUrl, testUser, testPassword);
    await page.goto(`${hostingUrl}/dashboard`);

    await gotoHydrated(page, `${hostingUrl}/create`);
    await page.fill('#post-title', 'Hello Nuxt');
    await page.fill('#post-body', 'My first post from the Nuxt SSR e2e test!');
    await page.click('#btn-publish');
    await page.waitForURL('**/dashboard');

    await expect(page.locator('[data-testid="my-post-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="my-posts"]')).toContainText('Hello Nuxt');
  });

  test('6. Dashboard SSR shows the post (auth-protected SSR)', async ({
    page,
    request,
  }) => {
    await loginViaApi(request, page.context(), hostingUrl, testUser, testPassword);
    await page.goto(`${hostingUrl}/dashboard`);

    await expect(page.locator('[data-testid="my-posts"]')).toContainText('Hello Nuxt');

    const cookies = await page.context().cookies();
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    const rawResp = await request.get(`${hostingUrl}/dashboard`, {
      headers: { Cookie: cookieStr },
    });
    const html = await rawResp.text();
    expect(html).toContain('Hello Nuxt');
    expect(html).toContain(testUser);
  });

  test('7. Homepage shows "Hello Nuxt" in public list (SSR)', async ({
    page,
    request,
  }) => {
    await page.goto(hostingUrl);
    await expect(page.locator('[data-testid="post-list"]')).toContainText('Hello Nuxt');

    const rawResp = await request.get(hostingUrl);
    const html = await rawResp.text();
    expect(html).toContain('Hello Nuxt');
  });

  test('8. Post detail page is server-rendered', async ({ page, request }) => {
    await page.goto(hostingUrl);
    const postLink = page.locator('[data-testid="post-card"] a').first();
    const href = await postLink.getAttribute('href');
    expect(href).toBeTruthy();

    const rawResp = await request.get(`${hostingUrl}${href}`);
    const html = await rawResp.text();
    expect(html).toContain('Hello Nuxt');
    expect(html).toContain('My first post from the Nuxt SSR e2e test!');

    await page.goto(`${hostingUrl}${href}`);
    await expect(page.locator('[data-testid="post-title"]')).toHaveText('Hello Nuxt');
    await expect(page.locator('[data-testid="post-body"]')).toContainText(
      'My first post',
    );
  });

  test('9. Profile page is server-rendered with user data (cookie forwarding proof)', async ({
    page,
    request,
  }) => {
    await loginViaApi(request, page.context(), hostingUrl, testUser, testPassword);
    await page.goto(`${hostingUrl}/profile`);
    await expect(page.locator('[data-testid="profile-username"]')).toHaveText(testUser);
    await expect(page.locator('[data-testid="profile-post-count"]')).toHaveText('1');

    const cookies = await page.context().cookies();
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const rawResp = await request.get(`${hostingUrl}/profile`, {
      headers: { Cookie: cookieStr },
    });
    const html = await rawResp.text();
    expect(html).toContain(testUser);
    expect(html).toContain('data-testid="profile-username"');
  });

  test('10. Delete post from dashboard', async ({ page, request }) => {
    await loginViaApi(request, page.context(), hostingUrl, testUser, testPassword);
    // The delete button is server-rendered, so it is visible (and "actionable" to `click()`)
    // before Vue attaches its `@click` handler. Wait for hydration, or the click does nothing.
    await gotoHydrated(page, `${hostingUrl}/dashboard`);

    await expect(page.locator('[data-testid="my-post-card"]')).toHaveCount(1);
    await page.locator('[data-testid="btn-delete"]').first().click();
    await page.waitForURL('**/dashboard');
    await expect(page.locator('[data-testid="no-posts"]')).toBeVisible();
  });

  test('11. Homepage no longer shows deleted post (SSR)', async ({ request }) => {
    const rawResp = await request.get(hostingUrl);
    const html = await rawResp.text();
    expect(html).not.toContain('Hello Nuxt');
    expect(html).toContain('No posts yet');
  });

  test('12. Unauthenticated /dashboard redirects to /login', async ({ page }) => {
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

  test('Streaming handler paces chunk generation server-side (200ms × 4 gaps ≈ 800ms span)', async ({
    request,
  }) => {
    // Scope of this test: prove the SSR handler is actually pacing its
    // writes — a regression where the handler buffers everything before
    // returning would collapse the timestamp span to ~0ms and fail here.
    //
    // What this does NOT prove: end-to-end progressive delivery through
    // CloudFront → APIGW REST. APIGW REST buffers the entire response
    // before forwarding, so the body arrives in a single burst regardless
    // of how the Lambda wrote it. The chunk timestamps are baked into the
    // body server-side, so the assertion below holds whether the gateway
    // streamed or buffered. Asserting on TTFB-vs-total at this layer would
    // be unreliable for the same reason — there is no observable signal
    // here that distinguishes streaming from buffering at the gateway.
    //
    // Tracking end-to-end streaming separately would require either a
    // Lambda Function URL probe (no APIGW in the path) or a TCP-level
    // capture; neither belongs in this Playwright suite.
    //
    // Warmup request to eliminate Lambda cold start (otherwise the first
    // chunk's timestamp is dominated by ~3-10s of cold-start latency).
    await request.get(`${hostingUrl}/api/probe/health`);

    const resp = await request.get(`${hostingUrl}/api/probe/stream`);
    expect(resp.status()).toBe(200);

    const text = await resp.text();
    expect(text).toContain('chunk 0');
    expect(text).toContain('chunk 4');

    // Each chunk has a server-stamped timestamp: "data: chunk N @ <Date.now()>\n\n"
    // 5 chunks with 200ms sleep between each = ~800ms span baked into the body.
    const timestamps = [...text.matchAll(/chunk \d+ @ (\d+)/g)].map((m) => Number(m[1]));
    expect(timestamps).toHaveLength(5);
    const span = timestamps[4] - timestamps[0];
    expect(span).toBeGreaterThanOrEqual(600);
    expect(span).toBeLessThan(3000);
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
