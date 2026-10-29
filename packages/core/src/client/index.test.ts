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

describe('ApiNamespaceClient — per-namespace request path', () => {
  // The typed client POSTs to `/aws-blocks/api/{namespace}` so a gateway can
  // route each namespace to the compute that hosts it. These spy on `fetch`
  // (test plumbing — not customer code) to assert the request URL.
  it('appends /{namespace} to the API base URL', async () => {
    const { ApiNamespaceClient } = await import('./index.js');
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ jsonrpc: '2.0', result: 'ok', id: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const api = ApiNamespaceClient<{ hello(): Promise<string> }>('reports', {
        url: 'https://d123.cloudfront.net/aws-blocks/api',
      });
      const result = await api.hello();
      assert.strictEqual(result, 'ok');
      assert.deepStrictEqual(calls, ['https://d123.cloudfront.net/aws-blocks/api/reports']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('tolerates a trailing slash on the API base URL', async () => {
    const { ApiNamespaceClient } = await import('./index.js');
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ jsonrpc: '2.0', result: 1, id: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const api = ApiNamespaceClient<{ ping(): Promise<number> }>('auth', { url: '/aws-blocks/api/' });
      await api.ping();
      assert.deepStrictEqual(calls, ['/aws-blocks/api/auth']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('builds the path from the namespace after middleware, so path and body stay in step', async () => {
    // A middleware may rewrite `apiNamespace`; the server rejects a path that
    // names a different namespace than the body, so both must carry the new one.
    const { ApiNamespaceClient, registerMiddleware } = await import('./index.js');
    // The middleware registry is process-global: rewrite only this test's namespace.
    registerMiddleware({
      onRequest: (request) =>
        request.apiNamespace === 'rewriteMe' ? { ...request, apiNamespace: 'rewritten' } : request,
    });
    const calls: Array<{ url: string; method: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(input), method: JSON.parse(String(init?.body)).method });
      return new Response(JSON.stringify({ jsonrpc: '2.0', result: 'ok', id: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const api = ApiNamespaceClient<{ ping(): Promise<string> }>('rewriteMe', { url: '/aws-blocks/api' });
      await api.ping();
      assert.deepStrictEqual(calls, [{ url: '/aws-blocks/api/rewritten', method: 'rewritten.ping' }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('ApiNamespaceClient — an RPC error decodes the same whatever the HTTP status', () => {
  // A namespace with `httpErrorStatus: true` answers a 4xx ApiError with that
  // HTTP status; the body is unchanged. The client must read the body either
  // way, so the error a caller sees does not depend on the option.
  const errorBody = JSON.stringify({
    jsonrpc: '2.0',
    error: { code: 401, message: 'Authentication required', data: { name: 'NotAuthenticated' } },
    id: 1,
  });

  async function callWithStatus(status: number): Promise<unknown> {
    const { ApiNamespaceClient } = await import('./index.js');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(errorBody, { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    try {
      const api = ApiNamespaceClient<{ whoami(): Promise<string> }>('api', { url: '/aws-blocks/api' });
      await api.whoami();
      assert.fail('expected the call to reject');
    } catch (e) {
      return e;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it('a 401 body on HTTP 401 and on HTTP 200 rejects with the same ApiError', async () => {
    const { ApiError, isBlocksError } = await import('./index.js');
    const on401 = await callWithStatus(401);
    const on200 = await callWithStatus(200);
    for (const e of [on401, on200]) {
      assert.ok(e instanceof ApiError);
      assert.strictEqual(e.status, 401);
      assert.strictEqual(e.name, 'NotAuthenticated');
      assert.strictEqual(e.message, 'Authentication required');
      assert.ok(isBlocksError(e, 'NotAuthenticated'));
    }
  });
});

describe('ApiNamespaceClient namespace identity', () => {
  it('answers Symbol.for("aws-blocks.apiNamespace") with its namespace, plus the URL when overridden', async () => {
    const { ApiNamespaceClient } = await import('./index.js');
    const key = Symbol.for('aws-blocks.apiNamespace');
    assert.strictEqual(Reflect.get(ApiNamespaceClient('pwAuth'), key), 'pwAuth');
    assert.strictEqual(
      Reflect.get(ApiNamespaceClient('pwAuth', { url: 'https://api.example.com' }), key),
      'https://api.example.com#pwAuth',
    );
    assert.strictEqual(Reflect.get(ApiNamespaceClient('pwAuth'), Symbol.for('other')), undefined, 'other symbols stay undefined');
  });
});

describe('ApiNamespaceClient — per-call fetch (test clients)', () => {
  // `@aws-blocks/blocks/utils`'s createTestClient runs each call inside an
  // AsyncLocalStorage whose store is the fetch to use (one cookie jar per test
  // user). The client reads it through a `Symbol.for` key on globalThis
  // (client/fetch-store.ts).
  const KEY = Symbol.for('blocks:ClientFetch');

  it('the key is exported once, from @aws-blocks/core/bb-utils', async () => {
    const { CLIENT_FETCH_STORE } = await import('../bb-utils.js');
    assert.strictEqual(CLIENT_FETCH_STORE, KEY);
  });
  const ok = () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', result: 'ok', id: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('a call made inside the store uses its fetch; other calls keep the global one', async () => {
    const { AsyncLocalStorage } = await import('node:async_hooks');
    const { ApiNamespaceClient } = await import('./index.js');
    const store = new AsyncLocalStorage<typeof fetch>();
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls.push('global');
      return ok();
    }) as typeof fetch;
    const scoped = (async () => {
      calls.push('scoped');
      return ok();
    }) as typeof fetch;
    Reflect.set(globalThis, KEY, store);
    try {
      for (const retryStaleConnection of [true, false]) {
        calls.length = 0;
        const api = ApiNamespaceClient<{ ping(): Promise<string> }>('api', {
          url: 'http://127.0.0.1:1/aws-blocks/api',
          retryStaleConnection,
        });
        assert.strictEqual(await store.run(scoped, () => api.ping()), 'ok');
        assert.strictEqual(await api.ping(), 'ok');
        assert.deepStrictEqual(calls, ['scoped', 'global'], `retryStaleConnection: ${retryStaleConnection}`);
      }
    } finally {
      Reflect.deleteProperty(globalThis, KEY);
      globalThis.fetch = originalFetch;
    }
  });
});
