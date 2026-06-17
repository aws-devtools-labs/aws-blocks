// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// E2E tests for the Astro static multi-page deployment — DEFAULT-404 variant.
//
// This app is identical to hosting-ssr-astro EXCEPT it ships NO custom
// 404.astro. That makes the adapter emit no `errorPages`, so the L3's
// built-in default-404 path kicks in: CloudFront remaps the S3-OAC 403 (and
// 404) for an unknown key onto `/builds/<id>/_not_found.html` at HTTP 404.
// hosting-ssr-astro covers the framework-emitted 404; this app gives the
// previously unit-only DEFAULT_NOT_FOUND_PAGE_HTML path real end-to-end
// coverage against live S3-OAC + CloudFront (Josh's review comment).
//
// Each test is annotated with the Report-1 test-matrix ID it covers.

import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const backendPath = join(__dirname, '..', 'aws-blocks', 'index.cdk.ts');

let hostingUrl: string;

test.beforeAll(async () => {
  if (ENV === 'sandbox') {
    console.log('🚀 Deploying hosting-ssr-astro sandbox...\n');
    execFileSync('npx', ['tsx', 'test/sandbox-deploy.ts', backendPath], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '' },
    });

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
    console.log(`\n✅ Deployed at: ${hostingUrl}\n`);
  } else {
    hostingUrl = process.env.HOSTING_URL || 'http://localhost:4321';
  }
});

test.afterAll(async () => {
  if (ENV === 'sandbox' && !process.env.BLOCKS_SANDBOX_KEEP) {
    console.log('\n🗑️  Destroying sandbox...');
    execFileSync('npx', ['tsx', 'test/sandbox-destroy.ts', backendPath], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
  }
});

/** Read the `data-testid="page-id"` heading text from raw HTML. */
function pageId(html: string): string | null {
  const m = html.match(/data-testid="page-id"[^>]*>([^<]*)</);
  return m ? m[1].trim() : null;
}

// ════════════════════════════════════════════════════════════════
// Multi-page routing — the core of this suite
// ════════════════════════════════════════════════════════════════

test.describe('Astro static multi-page — routing', () => {
  // M1.2 / AS1.1 — the catch-all on a static site serves the home page's
  // own index.html, and the home page is distinct.
  test('M1.2 / AS1.1 — home (/) serves the Home page', async ({ request }) => {
    const resp = await request.get(`${hostingUrl}/`);
    expect(resp.status()).toBe(200);
    expect(resp.headers()['content-type']).toContain('text/html');
    const html = await resp.text();
    expect(pageId(html)).toBe('Home');
    expect(html).toContain('data-testid="home-marker"');
  });

  // M1.4 — bare directory path resolves to its OWN index.html, NOT the
  // home page. This is the exact regression the spaFallback fix addresses.
  test('M1.4 — /about serves the About page (NOT the home page)', async ({ request }) => {
    const resp = await request.get(`${hostingUrl}/about`);
    expect(resp.status()).toBe(200);
    expect(resp.headers()['content-type']).toContain('text/html');
    const html = await resp.text();
    expect(pageId(html)).toBe('About');
    expect(html).toContain('data-testid="about-marker"');
    // Guard against the SPA-fallback regression: must not be the home page.
    expect(pageId(html)).not.toBe('Home');
  });

  // M1.5 — trailing-slash form resolves to the same page as M1.4.
  test('M1.5 — /about/ (trailing slash) serves the About page', async ({ request }) => {
    const resp = await request.get(`${hostingUrl}/about/`);
    expect(resp.status()).toBe(200);
    const html = await resp.text();
    expect(pageId(html)).toBe('About');
  });

  // M1.6 — deeply-nested multi-segment extensionless path resolves to its
  // own index.html.
  test('M1.6 — nested /docs/api/v1/getting-started resolves', async ({ request }) => {
    const resp = await request.get(`${hostingUrl}/docs/api/v1/getting-started`);
    expect(resp.status()).toBe(200);
    const html = await resp.text();
    expect(pageId(html)).toBe('Getting Started (nested)');
    expect(html).toContain('data-testid="nested-marker"');
  });

  // Distinct-content matrix: every route returns its own page, proving no
  // collapse-to-index. This is the single most important assertion set.
  test('multi-page distinctness — every route is its own page', async ({ request }) => {
    const cases: Array<[string, string]> = [
      ['/', 'Home'],
      ['/about', 'About'],
      ['/islands', 'Islands'],
      ['/posts', 'Posts'],
      ['/docs/api/v1/getting-started', 'Getting Started (nested)'],
    ];
    const seen = new Set<string>();
    for (const [path, expected] of cases) {
      const resp = await request.get(`${hostingUrl}${path}`);
      expect(resp.status(), `${path} status`).toBe(200);
      const id = pageId(await resp.text());
      expect(id, `${path} page-id`).toBe(expected);
      seen.add(id ?? '');
    }
    // All five page-ids must be distinct — no two paths share a body.
    expect(seen.size).toBe(cases.length);
  });

  // M1.3 — a path with an extension is left untouched by the rewrite and
  // served from S3 with the right content type.
  test('M1.3 — /favicon.svg (extension) served from S3', async ({ request }) => {
    // Astro ships a default favicon.svg in public/. If absent the build
    // still 404s cleanly; we assert the extension path is NOT rewritten to
    // HTML (which would indicate SPA fallback swallowing it).
    const resp = await request.get(`${hostingUrl}/favicon.svg`);
    expect([200, 403, 404]).toContain(resp.status());
    if (resp.status() === 200) {
      expect(resp.headers()['content-type']).toContain('image/svg');
    }
  });
});

// ════════════════════════════════════════════════════════════════
// Error pages (M7) — BUILT-IN default 404 (no custom 404.astro)
// ════════════════════════════════════════════════════════════════

test.describe('Astro static multi-page — built-in default 404', () => {
  // M7 (default-404 variant) — with no framework-emitted or user 404, an
  // unknown path must return a REAL 404 status served from the L3's
  // built-in default page (_not_found.html). This exercises the
  // S3-OAC 403 → 404 remap end-to-end. A SPA-fallback misclassification
  // would instead return 200 + the home page.
  test('unknown path returns 404 with the built-in default page', async ({ request }) => {
    const resp = await request.get(`${hostingUrl}/this/does/not/exist-12345`);
    // Real 404 status (not a 200 SPA fallback, not a raw S3-OAC 403).
    expect(resp.status()).toBe(404);
    const html = await resp.text();
    // Built-in DEFAULT_NOT_FOUND_PAGE_HTML content (NOT a custom 404.astro,
    // which this app does not ship — note absence of data-testid markers).
    expect(html).toContain('404 — Page Not Found');
    expect(html).toContain("doesn't exist");
    // The app ships no custom 404 page, so the framework marker must be absent.
    expect(html).not.toContain('data-testid="notfound-marker"');
  });

  // The /about page must still 404-free resolve to its own content — proves
  // the default-404 wiring did not break normal multi-page routing.
  test('multi-page routing still works (default-404 does not shadow real pages)', async ({ request }) => {
    const resp = await request.get(`${hostingUrl}/about`);
    expect(resp.status()).toBe(200);
    expect(pageId(await resp.text())).toBe('About');
  });
});

// ════════════════════════════════════════════════════════════════
// Redirects (M4 / AS6.3) — lifted to the edge CF Function
// ════════════════════════════════════════════════════════════════

test.describe('Astro static multi-page — redirects', () => {
  // AS6.3 / M4.1 — astro.config `redirects: { '/old-home': '/' }` is lifted
  // to the CloudFront viewer-request function (edge redirect, no origin).
  test('AS6.3 — /old-home redirects to / at the edge', async ({ request }) => {
    const resp = await request.get(`${hostingUrl}/old-home`, {
      maxRedirects: 0,
    });
    expect([301, 302, 307, 308]).toContain(resp.status());
    const location = resp.headers()['location'];
    expect(location).toBeTruthy();
    expect(location.replace(hostingUrl, '') || '/').toMatch(/^\/?$/);
  });
});

// ════════════════════════════════════════════════════════════════
// Islands architecture (AS) — selective hydration
// ════════════════════════════════════════════════════════════════

test.describe('Astro Islands — selective hydration', () => {
  // client:load island hydrates immediately and is interactive.
  test('client:load island hydrates and is interactive', async ({ page }) => {
    await page.goto(`${hostingUrl}/islands`, { waitUntil: 'networkidle' });
    const value = page.locator('[data-testid="counter-load-value"]');
    await expect(value).toHaveText('0');
    await page.locator('[data-testid="counter-load-btn"]').click();
    await expect(value).toHaveText('1');
  });

  // The page is static HTML; only island chunks ship JS (under /_astro/).
  test('island JS is served from /_astro/ (hashed, immutable)', async ({ request }) => {
    const html = await (await request.get(`${hostingUrl}/islands`)).text();
    const m = html.match(/\/_astro\/[^"']+\.js/);
    expect(m, 'island JS chunk referenced in HTML').toBeTruthy();
    const assetResp = await request.get(`${hostingUrl}${m![0]}`);
    expect(assetResp.status()).toBe(200);
    // M3.1 — hashed assets are immutable + 1y.
    expect(assetResp.headers()['cache-control']).toContain('immutable');
  });
});

// ════════════════════════════════════════════════════════════════
// Cache-Control split (M3) + single-origin API (M11.5 cousin)
// ════════════════════════════════════════════════════════════════

test.describe('Astro static multi-page — caching & API', () => {
  // M3.2 — HTML is edge-cacheable but browser-revalidated each deploy.
  test('M3.2 — HTML carries revalidating cache-control', async ({ request }) => {
    const resp = await request.get(`${hostingUrl}/about`);
    const cc = resp.headers()['cache-control'] ?? '';
    // Static HTML uses a short/zero max-age with must-revalidate so a
    // redeploy invalidates cached HTML on next request.
    expect(cc).toMatch(/must-revalidate|max-age=0|no-cache/);
  });

  // Single-origin proxy: config.json served from S3 with the relative API URL.
  test('config.json is served with the relative apiUrl', async ({ request }) => {
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

  // The Blocks backend is reachable through the SAME CloudFront domain at
  // the relative /aws-blocks/api path (single-origin, no CORS).
  test('single-origin /aws-blocks/api reaches the backend', async ({ request }) => {
    const resp = await request.post(`${hostingUrl}/aws-blocks/api`, {
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify({ jsonrpc: '2.0', method: 'api.listPosts', params: [], id: 1 }),
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    // listPosts returns an array (empty on a fresh deploy).
    expect(Array.isArray(body.result)).toBe(true);
  });

  // M6.5 / M6.6 — security headers present on a static HTML response.
  test('M6.5/M6.6 — security headers present', async ({ request }) => {
    const resp = await request.get(`${hostingUrl}/about`);
    expect(resp.headers()['x-content-type-options']).toBe('nosniff');
    expect((resp.headers()['x-frame-options'] ?? '').toUpperCase()).toBe('SAMEORIGIN');
  });
});

// ════════════════════════════════════════════════════════════════
// Browser navigation — clicking nav links lands on distinct pages
// ════════════════════════════════════════════════════════════════

test.describe('Astro static multi-page — browser navigation', () => {
  test('nav links land on distinct pages', async ({ page }: { page: Page }) => {
    await page.goto(`${hostingUrl}/`);
    await expect(page.locator('[data-testid="page-id"]')).toHaveText('Home');

    await page.click('nav a[href="/about"]');
    await expect(page.locator('[data-testid="page-id"]')).toHaveText('About');

    await page.click('nav a[href="/islands"]');
    await expect(page.locator('[data-testid="page-id"]')).toHaveText('Islands');
  });
});
