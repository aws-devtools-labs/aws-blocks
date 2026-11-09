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

describe('ApiNamespaceClient — non-JSON-RPC response bodies', () => {
  // A gateway or proxy in front of the handler can answer on its own (throttling,
  // auth, timeouts, a crashed integration). Those bodies carry no JSON-RPC
  // envelope; the client must reject with the HTTP status rather than resolve
  // `undefined`. These stub `fetch` (test plumbing — not customer code).
  async function callWith(body: string, status: number, contentType = 'application/json'): Promise<unknown> {
    const { ApiNamespaceClient } = await import('./index.js');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(body, {
      status,
      headers: { 'Content-Type': contentType },
    })) as typeof fetch;
    try {
      const api = ApiNamespaceClient<{ hello(): Promise<unknown> }>('reports', {
        url: 'https://d123.cloudfront.net/aws-blocks/api',
      });
      return await api.hello();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  const gatewayResponses: Array<[number, string]> = [
    [502, 'Internal server error'],
    [429, 'Too Many Requests'],
    [403, 'Forbidden'],
    [504, 'Endpoint request timed out'],
  ];
  for (const [status, message] of gatewayResponses) {
    it(`rejects with ApiError ${status} for a gateway body {"message":"${message}"}`, async () => {
      const { ApiError } = await import('./index.js');
      await assert.rejects(callWith(JSON.stringify({ message }), status), (err: unknown) => {
        assert.ok(err instanceof ApiError, `expected ApiError, got ${String(err)}`);
        assert.strictEqual(err.status, status);
        assert.strictEqual(err.message, message);
        return true;
      });
    });
  }

  it('rejects with ApiError carrying the status for a non-JSON body', async () => {
    const { ApiError } = await import('./index.js');
    await assert.rejects(callWith('<html><body>502 Bad Gateway</body></html>', 502, 'text/html'), (err: unknown) => {
      assert.ok(err instanceof ApiError, `expected ApiError, got ${String(err)}`);
      assert.strictEqual(err.status, 502);
      assert.strictEqual(err.message, 'HTTP 502');
      return true;
    });
  });

  it('rejects with status 502 when a 200 response carries no envelope', async () => {
    const { ApiError } = await import('./index.js');
    await assert.rejects(callWith(JSON.stringify({ hello: 'world' }), 200), (err: unknown) => {
      assert.ok(err instanceof ApiError, `expected ApiError, got ${String(err)}`);
      assert.strictEqual(err.status, 502);
      assert.strictEqual(err.message, 'HTTP 502');
      return true;
    });
  });

  it('resolves a valid void result (no `result` member)', async () => {
    assert.strictEqual(await callWith(JSON.stringify({ jsonrpc: '2.0', id: 1 }), 200), undefined);
  });

  it('resolves a valid result envelope sent with a custom non-200 status', async () => {
    assert.deepStrictEqual(await callWith(JSON.stringify({ jsonrpc: '2.0', result: { queued: true }, id: 1 }), 202), { queued: true });
    assert.strictEqual(await callWith(JSON.stringify({ jsonrpc: '2.0', result: 'teapot', id: 1 }), 418), 'teapot');
  });
});
