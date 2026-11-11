// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The SSR cache guard, run for real: the generated module is written to a
 * temp directory and imported, so the tests exercise the exact source the
 * construct writes into the server bundle. Importing it patches
 * `http.ServerResponse#writeHead` in this test process, which the HTTP server
 * tests rely on.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { Duration, Lazy } from 'aws-cdk-lib';
import type { ComputeResource } from '../manifest/types.js';
import {
  SSR_CACHE_GUARD_ENTRY_FILE,
  SSR_CACHE_GUARD_FILE,
  SSR_CACHE_GUARD_HANDLER,
  SSR_CACHE_GUARD_HANDLER_FILE,
  SSR_CACHE_GUARD_NODE_OPTION,
  generateSsrCacheGuardModule,
  isDefaultTtlPositive,
  withSsrCacheGuard,
  withSsrCacheGuardNodeOption,
} from './ssr_cache_guard.js';

type RequestInfo = { authorization: boolean; cookies: string[] };
type ResponseInfo = { cacheControl: string | undefined; expires?: string; setCookie: boolean; statusCode?: number };
type Headers = Record<string, string | string[]>;
type LambdaResult = {
  statusCode?: number;
  headers?: Headers;
  multiValueHeaders?: Record<string, string[]>;
  cookies?: string[];
  body?: string;
};
type GuardModule = {
  guardCacheControl: (request: RequestInfo | null, response: ResponseInfo) => string | null;
  requestInfoFromEvent: (event: unknown) => RequestInfo | null;
  guardResult: (result: LambdaResult, request: RequestInfo | null) => LambdaResult;
};

const PRIVATE = 'private, no-store';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssr-cache-guard-'));
let counter = 0;

/** Write the generated module (and any extra files) to a fresh dir and import `entry`. */
const load = async <T>(
  config: Parameters<typeof generateSsrCacheGuardModule>[0],
  extra: Record<string, string> = {},
  entry = SSR_CACHE_GUARD_FILE,
): Promise<T> => {
  const dir = path.join(tmpRoot, `m${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SSR_CACHE_GUARD_FILE), generateSsrCacheGuardModule(config));
  for (const [name, code] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), code);
  return (await import(pathToFileURL(path.join(dir, entry)).href)) as T;
};

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const anon: RequestInfo = { authorization: false, cookies: [] };
const shared = { cacheControl: 'public, s-maxage=300, max-age=0', setCookie: false };

void describe('guardCacheControl', () => {
  let guard: GuardModule;
  let keyed: GuardModule;
  before(async () => {
    guard = await load<GuardModule>({ cacheKeyCookies: ['bb_session'] });
    keyed = await load<GuardModule>({ cacheKeyCookies: ['bb_session'], cacheKeyHeaders: ['Authorization'] });
  });

  void it('makes a shared-cacheable response private when the request carries Authorization', () => {
    assert.equal(guard.guardCacheControl({ authorization: true, cookies: [] }, shared), PRIVATE);
  });

  void it('makes a shared-cacheable response private when the request carries a cookie outside the cache key', () => {
    assert.equal(guard.guardCacheControl({ authorization: false, cookies: ['bb_session', 'theme'] }, shared), PRIVATE);
  });

  void it('compares cookie names case-sensitively', () => {
    assert.equal(guard.guardCacheControl({ authorization: false, cookies: ['BB_SESSION'] }, shared), PRIVATE);
  });

  void it('leaves the response alone when the request carries only cache-key, preview and build-pin cookies', () => {
    const cookies = ['bb_session', '__prerender_bypass', '__next_preview_data', '__dpl'];
    assert.equal(guard.guardCacheControl({ authorization: false, cookies }, shared), null);
  });

  void it('makes a response with Set-Cookie private, even for an anonymous request, unless it is already private or no-store', () => {
    assert.equal(guard.guardCacheControl(anon, { cacheControl: 'public, s-maxage=300', setCookie: true }), PRIVATE);
    assert.equal(guard.guardCacheControl(anon, { cacheControl: 'no-cache', setCookie: true }), PRIVATE);
    assert.equal(guard.guardCacheControl(anon, { cacheControl: undefined, setCookie: true }), PRIVATE);
    for (const cacheControl of [PRIVATE, 'private, max-age=600', 'Private', 'no-store', 'public, NO-STORE', 'private="set-cookie"']) {
      assert.equal(guard.guardCacheControl(anon, { cacheControl, setCookie: true }), null, cacheControl);
    }
  });

  void it('leaves already-private, no-store and no-cache responses alone', () => {
    const request = { authorization: true, cookies: ['theme'] };
    for (const cacheControl of ['private, max-age=60', 'no-store', 'NO-STORE, max-age=60', 'no-cache', 'private, s-maxage=60']) {
      assert.equal(guard.guardCacheControl(request, { cacheControl, setCookie: false }), null, cacheControl);
    }
  });

  void it('treats s-maxage, public and max-age as shared-cacheable', () => {
    const request = { authorization: true, cookies: [] };
    for (const cacheControl of ['s-maxage=60', 'no-cache, s-maxage=60', 'public', 'max-age=60', 'Max-Age=60, must-revalidate']) {
      assert.equal(guard.guardCacheControl(request, { cacheControl, setCookie: false }), PRIVATE, cacheControl);
    }
  });

  void it('leaves an anonymous s-maxage response alone', () => {
    assert.equal(guard.guardCacheControl(anon, shared), null);
  });

  void it('leaves the response alone when authorization is a cache-key header (any case)', () => {
    assert.equal(keyed.guardCacheControl({ authorization: true, cookies: ['bb_session'] }, shared), null);
  });

  void it('with every cookie in the cache key, rewrites only for Authorization and Set-Cookie', async () => {
    const allKeyed = await load<GuardModule>({ allCookiesKeyed: true });
    assert.equal(allKeyed.guardCacheControl({ authorization: false, cookies: ['sess', 'theme'] }, shared), null);
    assert.equal(allKeyed.guardCacheControl({ authorization: true, cookies: ['sess'] }, shared), PRIVATE);
    assert.equal(allKeyed.guardCacheControl(anon, { ...shared, setCookie: true }), PRIVATE);
  });

  void it('treats a missing Cache-Control as cacheable only when the default TTL is positive', async () => {
    const request = { authorization: true, cookies: [] };
    assert.equal(guard.guardCacheControl(request, { cacheControl: undefined, setCookie: false }), null);
    const withTtl = await load<GuardModule>({ defaultTtlPositive: true });
    assert.equal(withTtl.guardCacheControl(request, { cacheControl: undefined, setCookie: false }), PRIVATE);
    assert.equal(withTtl.guardCacheControl(request, { cacheControl: 'must-revalidate', setCookie: false }), PRIVATE);
    assert.equal(withTtl.guardCacheControl(anon, { cacheControl: undefined, setCookie: false }), null);
  });

  void it('treats an error status CloudFront caches without caching headers as shared-cacheable', () => {
    const request = { authorization: false, cookies: ['theme'] };
    for (const statusCode of [404, 414, 500, 501, 502, 503, 504]) {
      assert.equal(guard.guardCacheControl(request, { cacheControl: undefined, setCookie: false, statusCode }), PRIVATE, String(statusCode));
      assert.equal(guard.guardCacheControl(request, { cacheControl: 'must-revalidate', setCookie: false, statusCode }), PRIVATE, String(statusCode));
    }
    for (const statusCode of [404, 500]) {
      for (const cacheControl of ['private', 'no-store', PRIVATE]) {
        assert.equal(guard.guardCacheControl(request, { cacheControl, setCookie: false, statusCode }), null, `${statusCode} ${cacheControl}`);
      }
      assert.equal(guard.guardCacheControl(anon, { cacheControl: undefined, setCookie: false, statusCode }), null);
    }
    // Other statuses fall back to the default TTL, which is 0 here.
    for (const statusCode of [200, 302, 400, 403, 410]) {
      assert.equal(guard.guardCacheControl(request, { cacheControl: undefined, setCookie: false, statusCode }), null, String(statusCode));
    }
  });

  void it('treats a future Expires as shared-cacheable when Cache-Control gives no TTL', () => {
    const request = { authorization: true, cookies: [] };
    const future = new Date(Date.now() + 3_600_000).toUTCString();
    assert.equal(guard.guardCacheControl(request, { cacheControl: undefined, expires: future, setCookie: false }), PRIVATE);
    assert.equal(guard.guardCacheControl(request, { cacheControl: 'must-revalidate', expires: future, setCookie: false }), PRIVATE);
    assert.equal(guard.guardCacheControl(anon, { cacheControl: undefined, expires: future, setCookie: false }), null);
  });

  void it('ignores a past, invalid or overridden Expires', () => {
    const request = { authorization: true, cookies: [] };
    const future = new Date(Date.now() + 3_600_000).toUTCString();
    const past = new Date(Date.now() - 3_600_000).toUTCString();
    for (const expires of [past, '0', 'not a date']) {
      assert.equal(guard.guardCacheControl(request, { cacheControl: undefined, expires, setCookie: false }), null, expires);
    }
    for (const cacheControl of ['private', 'no-store', 'no-cache']) {
      assert.equal(guard.guardCacheControl(request, { cacheControl, expires: future, setCookie: false }), null, cacheControl);
    }
  });
});

void describe('requestInfoFromEvent / guardResult', () => {
  let guard: GuardModule;
  before(async () => {
    guard = await load<GuardModule>({ cacheKeyCookies: ['bb_session'] });
  });

  void it('reads Authorization and cookie names from REST, HTTP API and multi-value events', () => {
    assert.deepEqual(guard.requestInfoFromEvent({ headers: { Authorization: 'Bearer x', Cookie: 'a=1; b=2' } }), {
      authorization: true,
      cookies: ['a', 'b'],
    });
    assert.deepEqual(guard.requestInfoFromEvent({ headers: {}, cookies: ['bb_session=1', 'c=3'] }), {
      authorization: false,
      cookies: ['bb_session', 'c'],
    });
    assert.deepEqual(guard.requestInfoFromEvent({ multiValueHeaders: { cookie: ['a=1', 'a=2'] } }), {
      authorization: false,
      cookies: ['a'],
    });
  });

  void it('rewrites Cache-Control in headers and multiValueHeaders, whatever its case', () => {
    const request = guard.requestInfoFromEvent({ headers: { cookie: 'theme=dark' } });
    const result = guard.guardResult(
      {
        statusCode: 200,
        headers: { 'Cache-Control': 's-maxage=60' },
        multiValueHeaders: { 'cache-control': ['s-maxage=60'] },
        body: 'x',
      },
      request,
    );
    assert.deepEqual(result.headers, { 'cache-control': PRIVATE });
    assert.deepEqual(result.multiValueHeaders, { 'cache-control': [PRIVATE] });
    assert.equal(result.body, 'x');
  });

  void it('writes Cache-Control only into the map that held it', () => {
    const request = guard.requestInfoFromEvent({ headers: { cookie: 'theme=dark' } });
    const inHeaders = guard.guardResult(
      { statusCode: 200, headers: { 'Cache-Control': 's-maxage=60' }, multiValueHeaders: { 'x-a': ['1'] } },
      request,
    );
    assert.deepEqual(inHeaders.headers, { 'cache-control': PRIVATE });
    assert.deepEqual(inHeaders.multiValueHeaders, { 'x-a': ['1'] });
    const inMulti = guard.guardResult(
      { statusCode: 200, headers: { 'x-a': '1' }, multiValueHeaders: { 'Cache-Control': ['s-maxage=60'] } },
      request,
    );
    assert.deepEqual(inMulti.headers, { 'x-a': '1' });
    assert.deepEqual(inMulti.multiValueHeaders, { 'cache-control': [PRIVATE] });
    // No Cache-Control to replace: multiValueHeaders takes it when present.
    const neither = guard.guardResult(
      { statusCode: 200, headers: { 'x-a': '1' }, multiValueHeaders: { 'set-cookie': ['a=1'] } },
      null,
    );
    assert.deepEqual(neither.headers, { 'x-a': '1' });
    assert.deepEqual(neither.multiValueHeaders, { 'set-cookie': ['a=1'], 'cache-control': [PRIVATE] });
  });

  void it('reads Expires from a buffered result', () => {
    const request = guard.requestInfoFromEvent({ headers: { cookie: 'theme=dark' } });
    const expires = new Date(Date.now() + 3_600_000).toUTCString();
    const result = guard.guardResult({ statusCode: 200, headers: { Expires: expires } }, request);
    assert.equal(result.headers?.['cache-control'], PRIVATE);
  });

  void it('reads the status code of a buffered result', () => {
    const request = guard.requestInfoFromEvent({ headers: { cookie: 'theme=dark' } });
    assert.equal(guard.guardResult({ statusCode: 404, headers: {}, body: 'not found' }, request).headers?.['cache-control'], PRIVATE);
    assert.equal(guard.guardResult({ statusCode: 500, body: 'error' }, request).headers?.['cache-control'], PRIVATE);
    assert.deepEqual(guard.guardResult({ statusCode: 500, headers: { 'cache-control': 'private' } }, request).headers, {
      'cache-control': 'private',
    });
    assert.deepEqual(guard.guardResult({ statusCode: 200, headers: {} }, request).headers, {});
  });

  void it('makes a result with cookies (HTTP API shape) private', () => {
    const result = guard.guardResult({ statusCode: 200, headers: { 'cache-control': 'public, max-age=60' }, cookies: ['a=1'] }, null);
    assert.equal(result.headers?.['cache-control'], PRIVATE);
  });

  void it('leaves an anonymous cacheable result unchanged', () => {
    const request = guard.requestInfoFromEvent({ headers: { cookie: 'bb_session=1' } });
    const result = guard.guardResult({ statusCode: 200, headers: { 'cache-control': 's-maxage=60' } }, request);
    assert.deepEqual(result.headers, { 'cache-control': 's-maxage=60' });
  });
});

void describe('handler wrapper', () => {
  type Handler = (event: unknown, ...rest: unknown[]) => Promise<LambdaResult | undefined>;
  const STREAMING = Symbol.for('aws.lambda.runtime.handler.streaming');

  void it('guards a buffered handler result', async () => {
    const dir = path.join(tmpRoot, `h${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.mjs'),
      "export const handler = async () => ({ statusCode: 200, headers: { 'cache-control': 's-maxage=60' }, body: 'ok' });\n",
    );
    const { resource, skipped } = withSsrCacheGuard({ type: 'handler', placement: 'regional', bundle: dir, handler: 'index.handler' }, {});
    assert.equal(skipped, undefined);
    assert.equal(resource.handler, SSR_CACHE_GUARD_HANDLER);
    const mod = (await import(pathToFileURL(path.join(dir, SSR_CACHE_GUARD_HANDLER_FILE)).href)) as { handler: Handler };
    const credentialed = await mod.handler({ headers: { authorization: 'Bearer x' } }, {});
    assert.equal(credentialed?.headers?.['cache-control'], PRIVATE);
    const anonymous = await mod.handler({ headers: {} }, {});
    assert.equal(anonymous?.headers?.['cache-control'], 's-maxage=60');
  });

  void it('guards the result a callback-style handler passes to its callback', async () => {
    const dir = path.join(tmpRoot, `h${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.mjs'),
      `export const handler = (event, context, callback) => {
  if (event.fail) return void setTimeout(() => callback(new Error('boom'), { statusCode: 500 }), 0);
  setTimeout(() => callback(null, { statusCode: 200, headers: { 'cache-control': 's-maxage=60' }, body: 'ok' }), 0);
};
`,
    );
    withSsrCacheGuard({ type: 'handler', placement: 'regional', bundle: dir, handler: 'index.handler' }, {});
    type Callback = (err: Error | null, res?: LambdaResult) => void;
    const mod = (await import(pathToFileURL(path.join(dir, SSR_CACHE_GUARD_HANDLER_FILE)).href)) as {
      handler: (event: unknown, context: unknown, callback: Callback) => unknown;
    };
    assert.equal(mod.handler.length, 3);
    const invoke = (event: unknown) =>
      new Promise<{ err: Error | null; res?: LambdaResult; returned: unknown }>((resolve) => {
        const returned = mod.handler(event, {}, (err, res) => resolve({ err, res, returned }));
      });
    const credentialed = await invoke({ headers: { cookie: 'theme=dark' } });
    assert.equal(credentialed.returned, undefined);
    assert.equal(credentialed.err, null);
    assert.equal(credentialed.res?.headers?.['cache-control'], PRIVATE);
    assert.equal((await invoke({ headers: {} })).res?.headers?.['cache-control'], 's-maxage=60');
    const failed = await invoke({ fail: true, headers: { cookie: 'theme=dark' } });
    assert.equal(failed.err?.message, 'boom');
    assert.deepEqual(failed.res, { statusCode: 500 });
  });

  void it('guards the prelude a streaming handler writes itself, and keeps its streaming marker', async () => {
    const dir = path.join(tmpRoot, `h${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    // Same framing as OpenNext's streaming wrapper: content type, JSON prelude,
    // 8 NUL bytes, then the body.
    fs.writeFileSync(
      path.join(dir, 'index.mjs'),
      `const run = async (event, stream) => {
  stream.setContentType('application/vnd.awslambda.http-integration-response');
  stream.write(JSON.stringify({ statusCode: 200, headers: { 'cache-control': 'public, s-maxage=60' }, cookies: [] }));
  stream.write(new Uint8Array(8));
  stream.write('{"headers":{"cache-control":"body"}}');
  stream.end();
};
run[Symbol.for('aws.lambda.runtime.handler.streaming')] = 'response';
export const handler = run;
`,
    );
    withSsrCacheGuard({ type: 'handler', placement: 'regional', bundle: dir, handler: 'index.handler' }, {});
    const mod = (await import(pathToFileURL(path.join(dir, SSR_CACHE_GUARD_HANDLER_FILE)).href)) as {
      handler: ((event: unknown, stream: unknown) => Promise<void>) & Record<symbol, unknown>;
    };
    assert.equal(mod.handler[STREAMING], 'response');
    const chunks: unknown[] = [];
    const stream = {
      setContentType: (_type: string) => undefined,
      write: (chunk: unknown) => {
        chunks.push(chunk);
        return true;
      },
      end: () => undefined,
    };
    await mod.handler({ headers: { cookie: 'theme=dark' } }, stream);
    assert.deepEqual(JSON.parse(String(chunks[0])).headers, { 'cache-control': PRIVATE });
    // Only the prelude is read; body chunks pass through untouched.
    assert.equal(chunks[2], '{"headers":{"cache-control":"body"}}');
  });

  void it('guards a prelude written together with the delimiter and body, keeping the rest byte for byte', async () => {
    const dir = path.join(tmpRoot, `h${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.mjs'),
      `const run = async (event, stream) => {
  stream.setContentType('application/vnd.awslambda.http-integration-response');
  const prelude = Buffer.from(JSON.stringify({ statusCode: 200, headers: { 'cache-control': 's-maxage=60' } }));
  stream.write(Buffer.concat([prelude, Buffer.alloc(8), Buffer.from([0xff, 0x00, 0x62])]));
  stream.end();
};
run[Symbol.for('aws.lambda.runtime.handler.streaming')] = 'response';
export const handler = run;
`,
    );
    withSsrCacheGuard({ type: 'handler', placement: 'regional', bundle: dir, handler: 'index.handler' }, {});
    const mod = (await import(pathToFileURL(path.join(dir, SSR_CACHE_GUARD_HANDLER_FILE)).href)) as {
      handler: (event: unknown, stream: unknown) => Promise<void>;
    };
    const chunks: Buffer[] = [];
    const stream = {
      setContentType: (_type: string) => undefined,
      write: (chunk: Buffer) => {
        chunks.push(chunk);
        return true;
      },
      end: () => undefined,
    };
    await mod.handler({ headers: { authorization: 'Bearer x' } }, stream);
    const written = chunks[0];
    const nul = written.indexOf(0);
    assert.deepEqual(JSON.parse(written.subarray(0, nul).toString('utf8')).headers, { 'cache-control': PRIVATE });
    assert.deepEqual([...written.subarray(nul)], [0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0x00, 0x62]);
  });

  void it('passes a first write through when its prelude is not JSON', async () => {
    const dir = path.join(tmpRoot, `h${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.mjs'),
      `const run = async (event, stream) => {
  stream.setContentType('application/vnd.awslambda.http-integration-response');
  stream.write('not json\\0\\0body');
  stream.end();
};
run[Symbol.for('aws.lambda.runtime.handler.streaming')] = 'response';
export const handler = run;
`,
    );
    withSsrCacheGuard({ type: 'handler', placement: 'regional', bundle: dir, handler: 'index.handler' }, {});
    const mod = (await import(pathToFileURL(path.join(dir, SSR_CACHE_GUARD_HANDLER_FILE)).href)) as {
      handler: (event: unknown, stream: unknown) => Promise<void>;
    };
    const chunks: unknown[] = [];
    const stream = {
      setContentType: (_type: string) => undefined,
      write: (chunk: unknown) => {
        chunks.push(chunk);
        return true;
      },
      end: () => undefined,
    };
    await mod.handler({ headers: { authorization: 'Bearer x' } }, stream);
    assert.equal(chunks[0], 'not json\0\0body');
  });

  void it('guards the prelude of a streaming handler that writes it without a content type', async () => {
    const dir = path.join(tmpRoot, `h${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    // OpenNext's streaming wrapper as built for API Gateway: the content type
    // call is removed, the prelude and 8 NUL bytes are still written first.
    fs.writeFileSync(
      path.join(dir, 'index.mjs'),
      `const run = async (event, stream) => {
  void 0;
  const cookies = event.path === '/set-cookie' ? ['v=1; Path=/'] : [];
  stream.write(JSON.stringify({ statusCode: 200, headers: { 'cache-control': 'public, s-maxage=300' }, cookies }));
  stream.write(new Uint8Array(8));
  stream.write('{"statusCode":200,"headers":{"cache-control":"body"}}');
  stream.end();
};
run[Symbol.for('aws.lambda.runtime.handler.streaming')] = 'response';
export const handler = run;
`,
    );
    withSsrCacheGuard({ type: 'handler', placement: 'regional', bundle: dir, handler: 'index.handler' }, { cacheKeyCookies: ['bb_session'] });
    const mod = (await import(pathToFileURL(path.join(dir, SSR_CACHE_GUARD_HANDLER_FILE)).href)) as {
      handler: (event: unknown, stream: unknown) => Promise<void>;
    };
    const invoke = async (event: unknown): Promise<unknown[]> => {
      const chunks: unknown[] = [];
      const stream = {
        setContentType: (_type: string) => undefined,
        write: (chunk: unknown) => {
          chunks.push(chunk);
          return true;
        },
        end: () => undefined,
      };
      await mod.handler(event, stream);
      return chunks;
    };
    const other = await invoke({ path: '/', headers: { Cookie: 'bb_other=1' } });
    assert.equal(JSON.parse(String(other[0])).headers['cache-control'], PRIVATE);
    assert.equal(other[2], '{"statusCode":200,"headers":{"cache-control":"body"}}');
    const setCookie = await invoke({ path: '/set-cookie', headers: {} });
    assert.equal(JSON.parse(String(setCookie[0])).headers['cache-control'], PRIVATE);
    const keyed = await invoke({ path: '/', headers: { Cookie: 'bb_session=1' } });
    assert.equal(JSON.parse(String(keyed[0])).headers['cache-control'], 'public, s-maxage=300');
  });

  void it('leaves the first write alone on a stream without a content type when it is not a prelude', async () => {
    const dir = path.join(tmpRoot, `h${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.mjs'),
      `const run = async (event, stream) => {
  stream.write('{"statusCode":200,"headers":{"cache-control":"s-maxage=60"},"data":1}');
  stream.end();
};
run[Symbol.for('aws.lambda.runtime.handler.streaming')] = 'response';
export const handler = run;
`,
    );
    withSsrCacheGuard({ type: 'handler', placement: 'regional', bundle: dir, handler: 'index.handler' }, {});
    const mod = (await import(pathToFileURL(path.join(dir, SSR_CACHE_GUARD_HANDLER_FILE)).href)) as {
      handler: (event: unknown, stream: unknown) => Promise<void>;
    };
    const chunks: unknown[] = [];
    const stream = {
      write: (chunk: unknown) => {
        chunks.push(chunk);
        return true;
      },
      end: () => undefined,
    };
    await mod.handler({ headers: { authorization: 'Bearer x' } }, stream);
    assert.equal(chunks[0], '{"statusCode":200,"headers":{"cache-control":"s-maxage=60"},"data":1}');
  });

  void it('leaves the first write alone on a stream with a non-prelude content type', async () => {
    const dir = path.join(tmpRoot, `h${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.mjs'),
      `const run = async (event, stream) => {
  stream.setContentType('application/json');
  stream.write('{"statusCode":200,"headers":{"cache-control":"s-maxage=60"}}');
  stream.end();
};
run[Symbol.for('aws.lambda.runtime.handler.streaming')] = 'response';
export const handler = run;
`,
    );
    withSsrCacheGuard({ type: 'handler', placement: 'regional', bundle: dir, handler: 'index.handler' }, {});
    const mod = (await import(pathToFileURL(path.join(dir, SSR_CACHE_GUARD_HANDLER_FILE)).href)) as {
      handler: (event: unknown, stream: unknown) => Promise<void>;
    };
    const chunks: unknown[] = [];
    const stream = {
      setContentType: (_type: string) => undefined,
      write: (chunk: unknown) => {
        chunks.push(chunk);
        return true;
      },
      end: () => undefined,
    };
    await mod.handler({ headers: { authorization: 'Bearer x' } }, stream);
    assert.equal(chunks[0], '{"statusCode":200,"headers":{"cache-control":"s-maxage=60"}}');
  });

  /** Wrap a streaming handler module (its source) and return the wrapper's handler. */
  const streamingWrapper = async (code: string) => {
    const dir = path.join(tmpRoot, `h${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.mjs'),
      `const run = async (event, stream) => {\n${code}\n};\nrun[Symbol.for('aws.lambda.runtime.handler.streaming')] = 'response';\nexport const handler = run;\n`,
    );
    withSsrCacheGuard({ type: 'handler', placement: 'regional', bundle: dir, handler: 'index.handler' }, {});
    const mod = (await import(pathToFileURL(path.join(dir, SSR_CACHE_GUARD_HANDLER_FILE)).href)) as {
      handler: (event: unknown, stream: unknown) => Promise<void>;
    };
    return mod.handler;
  };
  /** A response stream stand-in that records what reaches it, in order. */
  const recordingStream = () => {
    const calls: Array<{ op: 'write' | 'end'; chunk: Buffer | undefined }> = [];
    const asBuffer = (chunk: unknown) =>
      chunk == null || typeof chunk === 'function'
        ? undefined
        : Buffer.from(typeof chunk === 'string' ? chunk : (chunk as Uint8Array));
    const stream = {
      setContentType: (_type: string) => undefined,
      write: (chunk: unknown, ...rest: unknown[]) => {
        calls.push({ op: 'write', chunk: asBuffer(chunk) });
        const cb = rest.find((r) => typeof r === 'function') as ((err?: Error) => void) | undefined;
        cb?.();
        return true;
      },
      end: (chunk?: unknown, ...rest: unknown[]) => {
        calls.push({ op: 'end', chunk: asBuffer(chunk) });
        const cb = [chunk, ...rest].find((r) => typeof r === 'function') as (() => void) | undefined;
        cb?.();
      },
    };
    const bytes = () => Buffer.concat(calls.flatMap((c) => (c.chunk ? [c.chunk] : [])));
    const prelude = () => {
      const all = bytes();
      return JSON.parse(all.subarray(0, all.indexOf(0)).toString('utf8')) as { headers?: Headers };
    };
    return { stream, calls, bytes, prelude };
  };
  const PRELUDE_CT = "stream.setContentType('application/vnd.awslambda.http-integration-response');";

  void it('guards a prelude written through end() as the only call', async () => {
    const handler = await streamingWrapper(`${PRELUDE_CT}
  const prelude = JSON.stringify({ statusCode: 200, headers: { 'cache-control': 's-maxage=60' }, cookies: ['sess=1'] });
  stream.end(Buffer.concat([Buffer.from(prelude), Buffer.alloc(8), Buffer.from('body')]));`);
    const rec = recordingStream();
    await handler({ headers: {} }, rec.stream);
    assert.equal(rec.prelude().headers?.['cache-control'], PRIVATE);
    assert.equal(rec.bytes().subarray(rec.bytes().indexOf(0)).toString('utf8'), `${'\0'.repeat(8)}body`);
    assert.deepEqual(rec.calls.map((c) => c.op), ['end']);
  });

  void it('guards a prelude split over several writes, holding only the prelude bytes', async () => {
    const handler = await streamingWrapper(`${PRELUDE_CT}
  const prelude = JSON.stringify({ statusCode: 404, headers: { 'cache-control': 'public, s-maxage=60' } });
  stream.write(prelude.slice(0, 10));
  stream.write(Buffer.from(prelude.slice(10, 25)));
  stream.write(prelude.slice(25));
  stream.write(new Uint8Array(8));
  stream.write('{"statusCode":200,"headers":{"cache-control":"body"}}');
  stream.end();`);
    const rec = recordingStream();
    await handler({ headers: { authorization: 'Bearer x' } }, rec.stream);
    assert.deepEqual(rec.prelude().headers, { 'cache-control': PRIVATE });
    // The held fragments go out in one write once they parse; the body is not held.
    assert.equal(rec.calls.length, 4);
    assert.equal(rec.calls[2].chunk?.toString('utf8'), '{"statusCode":200,"headers":{"cache-control":"body"}}');
  });

  void it('does not decide on an empty first write', async () => {
    const handler = await streamingWrapper(`${PRELUDE_CT}
  stream.write('');
  stream.write(new Uint8Array(0));
  stream.write(JSON.stringify({ statusCode: 200, headers: { 'cache-control': 's-maxage=60' } }));
  stream.write(new Uint8Array(8));
  stream.end();`);
    const rec = recordingStream();
    await handler({ headers: { cookie: 'theme=dark' } }, rec.stream);
    assert.deepEqual(rec.prelude().headers, { 'cache-control': PRIVATE });
  });

  void it('calls the callbacks of held writes once the bytes are written', async () => {
    const handler = await streamingWrapper(`${PRELUDE_CT}
  const prelude = JSON.stringify({ statusCode: 200, headers: { 'cache-control': 's-maxage=60' } });
  const seen = [];
  stream.write(prelude.slice(0, 5), () => seen.push('a'));
  stream.write(prelude.slice(5), 'utf8', () => seen.push('b'));
  stream.end(() => { event.seen = seen; });`);
    const rec = recordingStream();
    const event: { headers: Headers; seen?: string[] } = { headers: { cookie: 'theme=dark' } };
    await handler(event, rec.stream);
    assert.deepEqual(event.seen, ['a', 'b']);
    assert.equal(JSON.parse(rec.bytes().toString('utf8')).headers['cache-control'], PRIVATE);
  });

  void it('passes held bytes on unchanged past the size limit, or when the stream ends without a prelude', async () => {
    const handler = await streamingWrapper(`${PRELUDE_CT}
  stream.write('{"statusCode":200,"headers":{"x":"');
  stream.write('a'.repeat(70 * 1024));
  stream.write('"}}');
  stream.end();`);
    const rec = recordingStream();
    await handler({ headers: { authorization: 'Bearer x' } }, rec.stream);
    assert.equal(rec.bytes().toString('utf8'), `{"statusCode":200,"headers":{"x":"${'a'.repeat(70 * 1024)}"}}`);
    const partial = await streamingWrapper(`${PRELUDE_CT}
  stream.write('{"statusCode":200');
  stream.end();`);
    const rec2 = recordingStream();
    await partial({ headers: { authorization: 'Bearer x' } }, rec2.stream);
    assert.equal(rec2.bytes().toString('utf8'), '{"statusCode":200');
  });

  void it('guards the prelude HttpResponseStream.from writes, and does not read the first body write as a prelude', async () => {
    // The guard module reads globalThis.awslambda when it is first evaluated,
    // so the stand-in runtime is installed before the wrapper (and the guard
    // module it imports, fresh in this directory) is loaded.
    const preludes: string[] = [];
    const runtime = {
      streamifyResponse: (fn: (...args: unknown[]) => unknown) => Object.assign(fn, { [STREAMING]: 'response' }),
      HttpResponseStream: {
        from: (underlying: { setContentType?: (type: string) => void }, prelude: unknown) => {
          preludes.push(JSON.stringify(prelude));
          underlying.setContentType?.('application/vnd.awslambda.http-integration-response');
          return underlying;
        },
      },
    };
    Reflect.set(globalThis, 'awslambda', runtime);
    try {
      const dir = path.join(tmpRoot, `h${counter++}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'index.mjs'),
        `export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const cookies = event.path === '/set-cookie' ? ['v=1; Path=/'] : [];
  const stream = awslambda.HttpResponseStream.from(responseStream, { statusCode: 200, headers: { 'cache-control': 'public, s-maxage=60' }, cookies });
  stream.write('{"statusCode":200,"headers":{"cache-control":"s-maxage=60"}}');
  stream.end();
});
`,
      );
      withSsrCacheGuard({ type: 'handler', placement: 'regional', bundle: dir, handler: 'index.handler' }, { cacheKeyCookies: ['bb_session'] });
      const mod = (await import(pathToFileURL(path.join(dir, SSR_CACHE_GUARD_HANDLER_FILE)).href)) as {
        handler: ((event: unknown, stream: unknown) => Promise<void>) & Record<symbol, unknown>;
      };
      assert.equal(mod.handler[STREAMING], 'response');
      const invoke = async (event: unknown) => {
        const rec = recordingStream();
        await mod.handler(event, rec.stream);
        return rec;
      };
      const credentialed = await invoke({ path: '/', headers: { cookie: 'theme=dark' } });
      assert.equal(JSON.parse(preludes[0]).headers['cache-control'], PRIVATE);
      assert.equal(credentialed.calls[0].chunk?.toString('utf8'), '{"statusCode":200,"headers":{"cache-control":"s-maxage=60"}}');
      await invoke({ path: '/set-cookie', headers: {} });
      assert.equal(JSON.parse(preludes[1]).headers['cache-control'], PRIVATE);
      await invoke({ path: '/', headers: { cookie: 'bb_session=1' } });
      assert.equal(JSON.parse(preludes[2]).headers['cache-control'], 'public, s-maxage=60');
    } finally {
      Reflect.deleteProperty(globalThis, 'awslambda');
    }
  });

  void it('wraps a CommonJS handler module, through its named export or the default export', async () => {
    const dir = path.join(tmpRoot, `h${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    // Assigned through a call, so Node cannot detect a named `handler` export
    // and the wrapper falls back to `default.handler`.
    fs.writeFileSync(
      path.join(dir, 'index.cjs'),
      "function build() {\n  return { handler: async () => ({ statusCode: 200, headers: { 'cache-control': 's-maxage=60' } }) };\n}\nmodule.exports = build();\n",
    );
    fs.writeFileSync(
      path.join(dir, 'named.cjs'),
      "exports.handler = async () => ({ statusCode: 200, headers: { 'cache-control': 'public, max-age=60' } });\n",
    );
    const fallback = await import(pathToFileURL(path.join(dir, 'index.cjs')).href);
    assert.equal((fallback as { handler?: unknown }).handler, undefined);
    const { resource } = withSsrCacheGuard({ type: 'handler', placement: 'regional', bundle: dir, handler: 'index.handler' }, {});
    assert.equal(resource.handler, SSR_CACHE_GUARD_HANDLER);
    assert.match(fs.readFileSync(path.join(dir, SSR_CACHE_GUARD_HANDLER_FILE), 'utf-8'), /from "\.\/index\.cjs"/);
    const mod = (await import(pathToFileURL(path.join(dir, SSR_CACHE_GUARD_HANDLER_FILE)).href)) as { handler: Handler };
    assert.equal((await mod.handler({ headers: { cookie: 'theme=dark' } }, {}))?.headers?.['cache-control'], PRIVATE);
    assert.equal((await mod.handler({ headers: {} }, {}))?.headers?.['cache-control'], 's-maxage=60');

    const namedDir = path.join(tmpRoot, `h${counter++}`);
    fs.mkdirSync(namedDir, { recursive: true });
    fs.copyFileSync(path.join(dir, 'named.cjs'), path.join(namedDir, 'index.cjs'));
    withSsrCacheGuard({ type: 'handler', placement: 'regional', bundle: namedDir, handler: 'index.handler' }, {});
    const named = (await import(pathToFileURL(path.join(namedDir, SSR_CACHE_GUARD_HANDLER_FILE)).href)) as { handler: Handler };
    assert.equal((await named.handler({ headers: { authorization: 'Bearer x' } }, {}))?.headers?.['cache-control'], PRIVATE);
  });

  void it('wraps a handler module in a subdirectory', async () => {
    const dir = path.join(tmpRoot, `h${counter++}`);
    fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'server', 'index.mjs'),
      "export const handler = async () => ({ statusCode: 200, headers: { 'cache-control': 's-maxage=60' } });\n",
    );
    const { resource, skipped } = withSsrCacheGuard(
      { type: 'handler', placement: 'regional', bundle: dir, handler: 'server/index.handler' },
      {},
    );
    assert.equal(skipped, undefined);
    assert.equal(resource.handler, SSR_CACHE_GUARD_HANDLER);
    assert.ok(fs.existsSync(path.join(dir, SSR_CACHE_GUARD_FILE)));
    const mod = (await import(pathToFileURL(path.join(dir, SSR_CACHE_GUARD_HANDLER_FILE)).href)) as { handler: Handler };
    assert.equal((await mod.handler({ headers: { cookie: 'theme=dark' } }, {}))?.headers?.['cache-control'], PRIVATE);
  });

  void it('passes a module without a matching handler export through unchanged', async () => {
    const dir = path.join(tmpRoot, `h${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.mjs'), 'export const other = async () => ({ statusCode: 200 });\n');
    const { resource } = withSsrCacheGuard({ type: 'handler', placement: 'regional', bundle: dir, handler: 'index.handler' }, {});
    assert.equal(resource.handler, SSR_CACHE_GUARD_HANDLER);
    const mod = (await import(pathToFileURL(path.join(dir, SSR_CACHE_GUARD_HANDLER_FILE)).href)) as { handler?: unknown };
    assert.equal(mod.handler, undefined);
  });
});

void describe('Node HTTP server (writeHead)', () => {
  let server: http.Server;
  let base: string;
  before(async () => {
    // The writeHead patch installs once per process, with the first loaded
    // module's config (every config in this file keys on bb_session).
    await load({ cacheKeyCookies: ['bb_session'] });
    server = http.createServer((req, res) => {
      if (req.url === '/set-header') {
        res.setHeader('Cache-Control', 'public, s-maxage=300');
        res.end('a');
      } else if (req.url === '/write-head') {
        res.writeHead(200, { 'Cache-Control': 'public, s-maxage=300', 'content-type': 'text/plain' });
        res.end('b');
      } else if (req.url === '/write-head-array') {
        res.writeHead(200, 'OK', ['Cache-Control', 's-maxage=300', 'content-type', 'text/plain']);
        res.end('c');
      } else if (req.url === '/not-found') {
        res.statusCode = 404;
        res.end('not found');
      } else if (req.url === '/error') {
        res.writeHead(500);
        res.end('error');
      } else if (req.url === '/error-private') {
        res.writeHead(500, { 'cache-control': 'private' });
        res.end('error');
      } else if (req.url === '/expires') {
        res.writeHead(200, { Expires: new Date(Date.now() + 3_600_000).toUTCString() });
        res.end('f');
      } else if (req.url === '/empty-set-cookie') {
        // OpenNext's node wrapper sets the prelude's cookies on every response,
        // usually an empty list, before writeHead.
        res.setHeader('Set-Cookie', []);
        res.writeHead(200, { 'cache-control': 'public, s-maxage=300' });
        res.end('g');
      } else if (req.url === '/set-cookie-private') {
        res.setHeader('Cache-Control', 'private, max-age=600');
        res.setHeader('Set-Cookie', 'v=1; Path=/');
        res.end('h');
      } else if (req.url === '/set-cookie') {
        res.setHeader('Cache-Control', 'public, s-maxage=300');
        res.setHeader('Set-Cookie', 'v=1; Path=/');
        res.end('d');
      } else {
        res.setHeader('Cache-Control', 'private, max-age=60');
        res.end('e');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const get = (p: string, headers: Record<string, string> = {}) => fetch(`${base}${p}`, { headers });

  void it('rewrites a setHeader Cache-Control for a credentialed request', async () => {
    assert.equal((await get('/set-header', { cookie: 'theme=dark' })).headers.get('cache-control'), PRIVATE);
    assert.equal((await get('/set-header', { authorization: 'Bearer x' })).headers.get('cache-control'), PRIVATE);
  });

  void it('rewrites a Cache-Control passed to writeHead (object and flat array)', async () => {
    assert.equal((await get('/write-head', { cookie: 'theme=dark' })).headers.get('cache-control'), PRIVATE);
    const res = await get('/write-head-array', { cookie: 'theme=dark' });
    assert.equal(res.headers.get('cache-control'), PRIVATE);
    assert.equal(res.headers.get('content-type'), 'text/plain');
  });

  void it('leaves responses to requests with only cache-key cookies alone', async () => {
    assert.equal((await get('/set-header', { cookie: 'bb_session=1' })).headers.get('cache-control'), 'public, s-maxage=300');
    assert.equal((await get('/write-head')).headers.get('cache-control'), 'public, s-maxage=300');
  });

  void it('treats a future Expires passed to writeHead as shared-cacheable', async () => {
    assert.equal((await get('/expires', { cookie: 'theme=dark' })).headers.get('cache-control'), PRIVATE);
    assert.equal((await get('/expires')).headers.get('cache-control'), null);
  });

  void it('makes an uncached error status private for a credentialed request', async () => {
    assert.equal((await get('/not-found', { cookie: 'theme=dark' })).headers.get('cache-control'), PRIVATE);
    assert.equal((await get('/error', { cookie: 'theme=dark' })).headers.get('cache-control'), PRIVATE);
    assert.equal((await get('/error-private', { cookie: 'theme=dark' })).headers.get('cache-control'), 'private');
    assert.equal((await get('/not-found')).headers.get('cache-control'), null);
  });

  void it('does not count an empty Set-Cookie value as setting a cookie', async () => {
    assert.equal((await get('/empty-set-cookie')).headers.get('cache-control'), 'public, s-maxage=300');
    assert.equal(
      (await get('/empty-set-cookie', { cookie: 'bb_session=1' })).headers.get('cache-control'),
      'public, s-maxage=300',
    );
    assert.equal((await get('/empty-set-cookie', { cookie: 'theme=dark' })).headers.get('cache-control'), PRIVATE);
  });

  void it('makes a response with Set-Cookie private', async () => {
    assert.equal((await get('/set-cookie')).headers.get('cache-control'), PRIVATE);
    assert.equal((await get('/set-cookie-private')).headers.get('cache-control'), 'private, max-age=600');
  });

  void it('leaves an already-private response alone', async () => {
    assert.equal((await get('/private', { cookie: 'theme=dark' })).headers.get('cache-control'), 'private, max-age=60');
  });
});

void describe('withSsrCacheGuard', () => {
  const bundle = (files: Record<string, string>): string => {
    const dir = path.join(tmpRoot, `b${counter++}`);
    for (const [name, code] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), code);
    }
    return dir;
  };

  void it('loads the guard through NODE_OPTIONS for a Lambda Web Adapter server', () => {
    const dir = bundle({ 'run.sh': '#!/bin/sh\ncd server\nexec node index.mjs\n' });
    const resource: ComputeResource = {
      type: 'http-server',
      placement: 'regional',
      bundle: dir,
      entrypoint: 'run.sh',
      environment: { NODE_OPTIONS: '--enable-source-maps' },
    };
    const { resource: out, skipped } = withSsrCacheGuard(resource, {});
    assert.equal(skipped, undefined);
    assert.equal(out.environment?.NODE_OPTIONS, `${SSR_CACHE_GUARD_NODE_OPTION} --enable-source-maps`);
    assert.ok(fs.existsSync(path.join(dir, SSR_CACHE_GUARD_FILE)));
    assert.equal(SSR_CACHE_GUARD_NODE_OPTION, `--import=file:///var/task/${SSR_CACHE_GUARD_FILE}`);
  });

  void it('adds the NODE_OPTIONS flag once', () => {
    assert.equal(withSsrCacheGuardNodeOption(undefined), SSR_CACHE_GUARD_NODE_OPTION);
    assert.equal(withSsrCacheGuardNodeOption(SSR_CACHE_GUARD_NODE_OPTION), SSR_CACHE_GUARD_NODE_OPTION);
  });

  void it('points a Web Function at an entry next to the server entry', () => {
    const dir = bundle({ 'server/index.mjs': 'export {};\n' });
    const { resource: out } = withSsrCacheGuard(
      { type: 'http-server', placement: 'regional', bundle: dir, serverEntry: 'server/index.mjs' },
      {},
      'web-function',
    );
    assert.equal(out.serverEntry, `server/${SSR_CACHE_GUARD_ENTRY_FILE}`);
    const entry = fs.readFileSync(path.join(dir, 'server', SSR_CACHE_GUARD_ENTRY_FILE), 'utf-8');
    assert.match(entry, /import "\.\/blocks_cache_guard\.mjs";/);
    assert.match(entry, /await import\("\.\/index\.mjs"\);/);
    assert.ok(fs.existsSync(path.join(dir, 'server', SSR_CACHE_GUARD_FILE)));
  });

  void it('leaves edge resources unchanged, and resources without a module in the bundle unchanged with a reason', () => {
    const dir = bundle({ 'other.mjs': '' });
    const edge: ComputeResource = { type: 'edge', placement: 'global', bundle: dir, handler: 'index.handler' };
    assert.deepEqual(withSsrCacheGuard(edge, {}), { resource: edge });
    const missing: ComputeResource = { type: 'handler', placement: 'regional', bundle: dir, handler: 'index.handler' };
    const out = withSsrCacheGuard(missing, {});
    assert.equal(out.resource, missing);
    assert.match(out.skipped ?? '', /handler module 'index'/);
  });

  void it('skips a Web Function whose server entry is not a JS module, with a reason', () => {
    const dir = bundle({ 'run.sh': '#!/bin/sh\nexec node index.mjs\n' });
    const resource: ComputeResource = { type: 'http-server', placement: 'regional', bundle: dir, entrypoint: 'run.sh' };
    const out = withSsrCacheGuard(resource, {}, 'web-function');
    assert.equal(out.resource, resource);
    assert.match(out.skipped ?? '', /not a \.js\/\.mjs\/\.cjs module/);
  });

  void it('skips a Lambda Web Adapter server that is not Node.js or drops NODE_OPTIONS, with a reason', () => {
    const notNode = bundle({ 'run.sh': '#!/bin/sh\nexec ./bootstrap --port 8080\n' });
    const a = withSsrCacheGuard({ type: 'http-server', placement: 'regional', bundle: notNode, entrypoint: 'run.sh' }, {});
    assert.match(a.skipped ?? '', /does not start a Node\.js server/);
    assert.equal(fs.existsSync(path.join(notNode, SSR_CACHE_GUARD_FILE)), false);
    const cleared = bundle({ 'run.sh': '#!/bin/sh\nunset NODE_OPTIONS\nexec node index.mjs\n' });
    const b = withSsrCacheGuard({ type: 'http-server', placement: 'regional', bundle: cleared, entrypoint: 'run.sh' }, {});
    assert.match(b.skipped ?? '', /replaces NODE_OPTIONS/);
    const replaced = bundle({ 'run.sh': '#!/bin/sh\nexport NODE_OPTIONS=--enable-source-maps\nexec node index.mjs\n' });
    assert.match(withSsrCacheGuard({ type: 'http-server', placement: 'regional', bundle: replaced, entrypoint: 'run.sh' }, {}).skipped ?? '', /replaces NODE_OPTIONS/);
    // Extending NODE_OPTIONS, or starting Node through node_modules/.bin, keeps the guard.
    const extended = bundle({ 'run.sh': '#!/bin/sh\nexport NODE_OPTIONS="--enable-source-maps $NODE_OPTIONS"\nexec ./node_modules/.bin/next start\n' });
    assert.equal(withSsrCacheGuard({ type: 'http-server', placement: 'regional', bundle: extended, entrypoint: 'run.sh' }, {}).skipped, undefined);
    const missing = bundle({ 'index.mjs': '' });
    assert.match(withSsrCacheGuard({ type: 'http-server', placement: 'regional', bundle: missing }, {}).skipped ?? '', /'run\.sh' is not in the bundle/);
  });

  void it('isDefaultTtlPositive: 0 and unset are not positive; a token is', () => {
    assert.equal(isDefaultTtlPositive(undefined), false);
    assert.equal(isDefaultTtlPositive(Duration.seconds(0)), false);
    assert.equal(isDefaultTtlPositive(Duration.seconds(60)), true);
    assert.equal(isDefaultTtlPositive(Duration.seconds(Lazy.number({ produce: () => 0 }))), true);
  });
});
