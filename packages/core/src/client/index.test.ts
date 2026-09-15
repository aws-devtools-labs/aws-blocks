// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Tests for the client's URL resolution defensive guard (issue #730).
 *
 * The client module caches API_URL globally, so each test spawns a
 * subprocess with appropriate env vars to get a fresh module instance.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_MODULE = join(__dirname, '..', 'client', 'index.js');

function runScript(scriptBody: string, env: Record<string, string>): string {
  const tmp = mkdtempSync(join(tmpdir(), 'blocks-client-test-'));
  const scriptPath = join(tmp, 'test.mjs');
  // Use absolute path to import the client module
  const importPath = `file://${CLIENT_MODULE}`;
  const fullScript = `import { ApiNamespaceClient } from '${importPath}';\n${scriptBody}`;
  writeFileSync(scriptPath, fullScript);
  try {
    return execSync(`node ${scriptPath}`, {
      encoding: 'utf-8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      timeout: 10000,
    }).trim();
  } finally {
    try { unlinkSync(scriptPath); } catch {}
  }
}

describe('Client URL validation (issue #730)', () => {
  it('ApiNamespaceClient with explicit url option containing "undefined" does NOT throw on creation', async () => {
    const { ApiNamespaceClient } = await import('./index.js');
    const client = ApiNamespaceClient('test', { url: 'https://undefined.example.com' });
    assert.ok(client, 'Should create client proxy');
  });

  it('resolveApiUrl rejects when BLOCKS_API_URL contains "undefined"', () => {
    const result = runScript(`
const api = ApiNamespaceClient('test');
try {
  await api.hello();
  console.log('FAIL:no_error');
} catch (e) {
  if (e.message.includes('Blocks API URL is not configured')) {
    console.log('PASS');
  } else {
    console.log('FAIL:' + e.message);
  }
}
`, { BLOCKS_API_URL: 'https://undefined/api' });
    assert.ok(result.includes('PASS'), `Expected PASS, got: ${result}`);
  });

  it('resolveApiUrl rejects when BLOCKS_CONFIG has missing apiUrl', () => {
    const result = runScript(`
const api = ApiNamespaceClient('test');
try {
  await api.hello();
  console.log('FAIL:no_error');
} catch (e) {
  if (e.message.includes('Blocks API URL is not configured') || e.message.includes('Blocks API URL not configured')) {
    console.log('PASS');
  } else {
    console.log('FAIL:' + e.message);
  }
}
`, { BLOCKS_CONFIG: JSON.stringify({ region: 'us-east-1' }) });
    assert.ok(result.includes('PASS'), `Expected PASS, got: ${result}`);
  });

  it('resolveApiUrl succeeds with valid BLOCKS_API_URL', () => {
    const result = runScript(`
const api = ApiNamespaceClient('test');
try {
  await api.hello();
  console.log('FAIL:no_error');
} catch (e) {
  if (e.message.includes('fetch') || e.message.includes('ENOTFOUND') || e.message.includes('getaddrinfo')) {
    console.log('PASS:url_resolved_fetch_failed');
  } else if (e.message.includes('Blocks API URL')) {
    console.log('FAIL:url_rejected_valid');
  } else {
    console.log('PASS:other');
  }
}
`, { BLOCKS_API_URL: 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/aws-blocks' });
    assert.ok(result.includes('PASS'), `Expected PASS, got: ${result}`);
  });

  it('resolveApiUrl accepts relative URLs (e.g. /aws-blocks/api for SPA hosting)', () => {
    const result = runScript(`
const api = ApiNamespaceClient('test');
try {
  await api.hello();
  console.log('FAIL:no_error');
} catch (e) {
  if (e.message.includes('fetch') || e.message.includes('ENOTFOUND') || e.message.includes('getaddrinfo') || e.message.includes('Invalid URL')) {
    console.log('PASS:url_resolved_fetch_failed');
  } else if (e.message.includes('Blocks API URL')) {
    console.log('FAIL:url_rejected_relative');
  } else {
    console.log('PASS:other');
  }
}
`, { BLOCKS_API_URL: '/aws-blocks/api' });
    assert.ok(result.includes('PASS'), `Expected PASS, got: ${result}`);
  });
});

/**
 * Tests for the per-namespace request path (multi-compute routing).
 *
 * The client POSTs to `{baseUrl}/{namespace}` so a front door can route each
 * namespace to the compute that hosts it. These use the `{ url }` override so
 * they never touch config.json discovery (which caches globally), letting them
 * run in-process against a stubbed `fetch`.
 */
describe('Client per-namespace request path', () => {
  /** Calls one method through the client and returns what `fetch` received. */
  async function captureRequest(
    namespace: string,
    baseUrl: string,
  ): Promise<{ url: string; body: any }> {
    const { ApiNamespaceClient } = await import('./index.js');
    const originalFetch = globalThis.fetch;
    let captured: { url: string; body: any } | undefined;
    globalThis.fetch = (async (input: any, init: any) => {
      captured = { url: String(input), body: JSON.parse(init.body) };
      return { json: async () => ({ jsonrpc: '2.0', result: 'ok', id: 1 }) };
    }) as unknown as typeof globalThis.fetch;
    try {
      const api = ApiNamespaceClient<{ hello: () => Promise<string> }>(namespace, { url: baseUrl });
      await api.hello();
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.ok(captured, 'fetch should have been called');
    return captured;
  }

  it('appends /{namespace} to the base URL', async () => {
    const { url } = await captureRequest('orders', 'https://api.example.com/aws-blocks/api');
    assert.strictEqual(url, 'https://api.example.com/aws-blocks/api/orders');
  });

  it('routes distinct namespaces to distinct paths', async () => {
    // This is the whole point of the path segment: without it every namespace
    // would hit one path and a front door could not fan out to per-namespace computes.
    const orders = await captureRequest('orders', 'https://api.example.com/aws-blocks/api');
    const authApi = await captureRequest('authApi', 'https://api.example.com/aws-blocks/api');
    assert.notStrictEqual(orders.url, authApi.url);
    assert.strictEqual(authApi.url, 'https://api.example.com/aws-blocks/api/authApi');
  });

  it('tolerates a trailing slash on the base URL without doubling it', async () => {
    const { url } = await captureRequest('orders', 'https://api.example.com/aws-blocks/api/');
    assert.strictEqual(url, 'https://api.example.com/aws-blocks/api/orders');
  });

  it('appends to a relative base URL (same-origin browser calls via Hosting)', async () => {
    // Hosting publishes a relative apiUrl ('/aws-blocks/api') in config.json.
    const { url } = await captureRequest('api', '/aws-blocks/api');
    assert.strictEqual(url, '/aws-blocks/api/api');
  });

  it('keeps the namespace in the RPC body — the path is only for routing', async () => {
    // The server dispatches on the body, not the path, so the namespace must
    // stay in `method`. Dropping it here would break dispatch even though the
    // URL still looks correct.
    const { body } = await captureRequest('orders', 'https://api.example.com/aws-blocks/api');
    assert.strictEqual(body.method, 'orders.hello');
  });
});
