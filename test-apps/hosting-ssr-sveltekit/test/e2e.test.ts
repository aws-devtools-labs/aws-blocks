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

test.beforeAll(async () => {
  if (ENV === 'sandbox') {
    console.log('🚀 Deploying hosting-ssr-sveltekit sandbox...\n');
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
    hostingUrl = process.env.HOSTING_URL || 'http://localhost:3000';
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

test.describe('SvelteKit SSR Hosting', () => {
  test('home is server-rendered', async ({ request }) => {
    const r = await request.get(hostingUrl);
    expect(r.ok()).toBe(true);
    const html = await r.text();
    expect(html).toContain('data-testid="ssr-home-marker"');
  });

  test('SSR page renders per-request server data', async ({ request }) => {
    const r = await request.get(`${hostingUrl}/ssr`);
    expect(r.ok()).toBe(true);
    const html = await r.text();
    expect(html).toContain('ssr-marker');
    expect(html).toMatch(/ssr-rendered-at">.+/);
  });

  test('prerendered /about is served from S3 (no compute)', async ({ request }) => {
    const r = await request.get(`${hostingUrl}/about`);
    expect(r.ok()).toBe(true);
    const html = await r.text();
    expect(html).toContain('about-marker');
  });

  test('+server.js endpoint returns JSON for all verbs', async ({ request }) => {
    const get = await request.get(`${hostingUrl}/api/echo?x=1`);
    expect((await get.json()).method).toBe('GET');
    expect(get.headers()['x-sk-endpoint']).toBe('echo');

    const post = await request.post(`${hostingUrl}/api/echo`, {
      data: { ping: 'pong' },
    });
    expect((await post.json()).body.ping).toBe('pong');

    const del = await request.delete(`${hostingUrl}/api/echo`);
    expect((await del.json()).deleted).toBe(true);
  });

  test('form action POST round-trips', async ({ page }) => {
    await page.goto(`${hostingUrl}/form`);
    await page.getByTestId('name-input').fill('Sveltey');
    await page.getByTestId('greet-submit').click();
    await expect(page.getByTestId('greet-result')).toHaveText('Hello, Sveltey!');
  });

  test('streaming page streams a deferred value', async ({ page }) => {
    await page.goto(`${hostingUrl}/streaming`);
    await expect(page.getByTestId('stream-eager')).toHaveText('shell-ready');
    await expect(page.getByTestId('stream-resolved')).toContainText('streamed-');
  });

  test('custom header + s-maxage survive the edge', async ({ request }) => {
    const r = await request.get(`${hostingUrl}/headers`);
    expect(r.ok()).toBe(true);
    expect(r.headers()['x-stress-test']).toBe('on');
    expect(r.headers()['cache-control'] ?? '').toMatch(/s-maxage=120/);
  });

  test('cookie round-trips via hooks.server', async ({ request }) => {
    const r = await request.get(`${hostingUrl}/api/whoami`);
    const j = await r.json();
    expect(typeof j.visit).toBe('string');
  });

  test('server redirect returns 30x', async ({ request }) => {
    const r = await request.get(`${hostingUrl}/redirect`, {
      maxRedirects: 0,
    });
    expect([301, 302, 307, 308]).toContain(r.status());
    expect(r.headers()['location'] ?? '').toContain('/about');
  });

  test('error() returns a real 500 with no leaked stack', async ({ request }) => {
    const r = await request.get(`${hostingUrl}/error-demo`);
    expect(r.status()).toBe(500);
    const html = await r.text();
    expect(html).not.toMatch(/\/var\/task|\.js:\d+:\d+/);
  });

  test('a hashed _app/immutable asset is served immutable from S3', async ({ request }) => {
    const home = await request.get(hostingUrl);
    const html = await home.text();
    const m = html.match(/(?:src|href)="([^"]*\/_app\/immutable\/[^"]*\.(?:js|css))"/);
    expect(m, 'home references an _app/immutable asset').toBeTruthy();
    const url = m![1].startsWith('http') ? m![1] : `${hostingUrl}${m![1]}`;
    const r = await request.get(url);
    expect(r.status()).toBe(200);
    expect(r.headers()['cache-control'] ?? '').toMatch(/immutable|max-age=\d{5,}/);
  });

  test('backend API reachable via single-origin proxy', async ({ request }) => {
    const r = await request.post(`${hostingUrl}/aws-blocks/api`, {
      headers: { 'Content-Type': 'application/json' },
      data: { jsonrpc: '2.0', method: 'api.ping', params: [], id: 1 },
    });
    expect(r.ok()).toBe(true);
    const body = await r.json();
    expect(body.result?.ok).toBe(true);
  });
});
