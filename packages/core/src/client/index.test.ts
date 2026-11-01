// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';

/**
 * Tests for the client's URL resolution defensive guard (issue #730).
 *
 * The client module caches API_URL globally, so each test spawns a
 * subprocess with appropriate env vars to get a fresh module instance.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_MODULE = join(__dirname, '..', 'client', 'index.js');

function runScript(scriptBody: string, env: Record<string, string>, cwd?: string): string {
  const tmp = mkdtempSync(join(tmpdir(), 'blocks-client-test-'));
  const scriptPath = join(tmp, 'test.mjs');
  // Use absolute path to import the client module
  const importPath = `file://${CLIENT_MODULE}`;
  const fullScript = `import { ApiNamespaceClient } from '${importPath}';\n${scriptBody}`;
  writeFileSync(scriptPath, fullScript);
  try {
    // A fresh directory, so no `.blocks-sandbox/config.json` of the cwd answers before the browser fetch.
    return execSync(`node ${scriptPath}`, {
      cwd: tmp,
      encoding: 'utf-8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      cwd,
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

  it('calls a relative apiUrl from the fetched config.json at the page origin', () => {
    // A dev server bound to all interfaces serves {"apiUrl": "/aws-blocks/api"}. The browser
    // resolves each request against the page, so the client must pass the path on as it is.
    const result = runScript(`
const calls = [];
globalThis.fetch = async (input) => {
  calls.push(String(input));
  const body = calls.length === 1
    ? { apiUrl: '/aws-blocks/api', environment: 'local' }
    : { jsonrpc: '2.0', result: 'ok', id: 1 };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const api = ApiNamespaceClient('greet');
console.log(JSON.stringify({ result: await api.hello(), calls }));
`, {});
    assert.deepStrictEqual(JSON.parse(result.split('\n').at(-1) ?? ''), {
      result: 'ok',
      calls: ['/.blocks-sandbox/config.json', '/aws-blocks/api/greet'],
    });
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

/**
 * The client entry is bundled for browsers and React Native. Expo's Metro
 * honors `webpackIgnore` and leaves a dynamic `import()` in the bundle, which
 * Hermes cannot compile, and Metro cannot resolve a Node built-in at all. So
 * nothing the client entry reaches may contain a dynamic `import()` or import a
 * Node built-in, even behind a runtime `process.versions.node` guard.
 */
describe('Client bundle safety (React Native / Hermes)', () => {
  const distDir = join(dirname(CLIENT_MODULE), '..');

  /**
   * Walk the built import graph from the client entry, the way a bundler does,
   * and collect what breaks a React Native bundle. The specifier text does not
   * matter for `import()`: Hermes rejects the expression itself.
   */
  function clientGraph(): { files: string[]; dynamicImports: string[]; nonRelativeImports: string[] } {
    const files = new Set<string>();
    const dynamicImports: string[] = [];
    const nonRelativeImports: string[] = [];
    const queue = [CLIENT_MODULE];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (files.has(file)) continue;
      files.add(file);
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
      const where = (node: ts.Node) =>
        `${relative(distDir, file)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
      const visit = (node: ts.Node): void => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const specifier = node.moduleSpecifier.text;
          if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier));
          else nonRelativeImports.push(`${where(node)} ${isBuiltin(specifier) ? 'Node built-in' : 'package'} '${specifier}'`);
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          dynamicImports.push(`${where(node)} ${node.getText(sf)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    return { files: [...files], dynamicImports, nonRelativeImports };
  }

  it('nothing the client entry reaches contains a dynamic import()', () => {
    const graph = clientGraph();
    assert.ok(graph.files.length > 1, 'expected the walk to leave dist/client');
    assert.deepStrictEqual(graph.dynamicImports, [], 'a dynamic import() in the client graph breaks the Hermes compile');
  });

  it('the client entry reaches only files of this package: no Node built-in, no other package', () => {
    // A Node built-in does not resolve in a browser or React Native bundle. A
    // package import is outside this walk: follow it here before you add one.
    assert.deepStrictEqual(clientGraph().nonRelativeImports, []);
  });

  /** Run `fn` in a project directory whose `.blocks-sandbox/config.json` names an API URL. */
  function withConfigFile(fn: (projectDir: string) => void): void {
    const projectDir = mkdtempSync(join(tmpdir(), 'blocks-client-cwd-'));
    try {
      mkdirSync(join(projectDir, '.blocks-sandbox'));
      writeFileSync(
        join(projectDir, '.blocks-sandbox', 'config.json'),
        JSON.stringify({ apiUrl: 'https://from-config-file.example.com/aws-blocks' }),
      );
      fn(projectDir);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }

  it('still reads .blocks-sandbox/config.json from the working directory under Node', () => {
    withConfigFile((projectDir) => {
      const result = runScript(`
globalThis.fetch = async (url) => {
  console.log('FETCH:' + String(url));
  throw new Error('stop');
};
const api = ApiNamespaceClient('test');
try { await api.hello(); } catch {}
`, {}, projectDir);
      assert.ok(
        result.includes('FETCH:https://from-config-file.example.com/aws-blocks'),
        `Expected the request to use the config.json apiUrl, got: ${result}`,
      );
    });
  });

  it('without process.getBuiltinModule (Node.js older than 22.3) skips the config file and says why', () => {
    withConfigFile((projectDir) => {
      const result = runScript(`
delete process.getBuiltinModule;
globalThis.fetch = async (url) => {
  console.log('FETCH:' + String(url));
  throw new Error('stop');
};
const api = ApiNamespaceClient('test');
try {
  await api.hello();
  console.log('FAIL:no_error');
} catch (e) {
  console.log('ERROR:' + e.message);
}
`, {}, projectDir);
      // The only request is the fetch step: the apiUrl in the config file is never used.
      const requests = result.split('\n').filter((line) => line.startsWith('FETCH:'));
      assert.deepStrictEqual(requests, ['FETCH:/.blocks-sandbox/config.json'], `Expected only the fetch step, got: ${result}`);
      assert.ok(result.includes('ERROR:Blocks API URL not configured'), `Expected the not-configured error, got: ${result}`);
      assert.ok(result.includes('that needs Node.js 22.3 or later'), `Expected the error to name the Node.js requirement, got: ${result}`);
    });
  });
});
