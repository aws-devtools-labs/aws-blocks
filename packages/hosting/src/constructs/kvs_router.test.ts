// Tests for the KVS edge router (kvs_router.ts).
//
// The router functions ship as generated JS strings that run at the CloudFront
// edge against a KeyValueStore. These tests cover the two halves:
//   1. buildKvsEntries — the manifest → KVS map (meta-last ordering, the
//      build-time budget guards, the skew flag).
//   2. The generated request/response function CODE — evaluated in a Node
//      sandbox with a fake `cloudfront` module + a KVS stub seeded from
//      buildKvsEntries, so the actual edge logic (glob matching, trailing-slash
//      normalization, skew-cookie gating) is exercised end-to-end.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKvsEntries,
  generateKvsRouterRequestCode,
  generateKvsRouterResponseCode,
  generateSentinelGuardCode,
  ORIGIN_ID,
} from './kvs_router.js';
import type { DeployManifest } from '../manifest/types.js';

const baseManifest = (overrides: Partial<DeployManifest> = {}): DeployManifest =>
  ({
    version: 1,
    compute: {},
    staticAssets: { directory: '/tmp/assets' },
    routes: [{ pattern: '/*', target: 'static' }],
    buildId: 'b1',
    ...overrides,
  }) as DeployManifest;

/**
 * Evaluate a generated CloudFront Function string against a KVS map. Strips the
 * `import cf from 'cloudfront'` ESM line and injects fakes, then returns the
 * `handler`'s output. `selectedOrigin` captures cf.selectRequestOriginById.
 */
async function runRequestFn(
  code: string,
  entries: Record<string, string>,
  request: Record<string, unknown>,
): Promise<{ output: any; selectedOrigin: string | null }> {
  let selectedOrigin: string | null = null;
  const cf = {
    kvs: () => ({
      get: async (key: string) => {
        if (!(key in entries)) throw new Error('NoSuchKey');
        return entries[key];
      },
    }),
    selectRequestOriginById: (id: string) => {
      selectedOrigin = id;
    },
  };
  const body = code.replace(/^import cf from 'cloudfront';\n?/, '');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    'cf',
    `${body}\nreturn handler;`,
  );
  const handler = factory(cf);
  const output = await handler({ request });
  return { output, selectedOrigin };
}

void describe('buildKvsEntries — atomicity & guards', () => {
  void it('writes `meta` as the LAST key (coherent mid-deploy view)', () => {
    const entries = buildKvsEntries({
      manifest: baseManifest({
        routes: [
          { pattern: '/a', target: 'static' },
          { pattern: '/b', target: 'static' },
          { pattern: '/api/*', target: 'compute' },
        ],
        redirects: [{ source: '/old', destination: '/new', statusCode: 308 }],
        headers: [{ source: '/secure', headers: { 'x-frame-options': 'DENY' } }],
      }),
      buildId: 'b1',
      hasServer: true,
      hasImage: false,
    });
    const keys = Object.keys(entries);
    assert.equal(keys[keys.length - 1], 'meta', 'meta must be the last inserted key');
  });

  void it('records the skew flag in meta (sk:1 enabled, sk:0 disabled)', () => {
    const on = buildKvsEntries({
      manifest: baseManifest(),
      buildId: 'b1',
      hasServer: false,
      hasImage: false,
      skewEnabled: true,
    });
    const off = buildKvsEntries({
      manifest: baseManifest(),
      buildId: 'b1',
      hasServer: false,
      hasImage: false,
      skewEnabled: false,
    });
    assert.equal(JSON.parse(on.meta).sk, 1);
    assert.equal(JSON.parse(off.meta).sk, 0);
  });

  void it('throws TooManyRoutesError when one table exceeds the chunk budget', () => {
    // Each route pattern is unique + long enough that chunking produces many
    // chunks. 3000 distinct routes guarantees >64 chunks.
    const routes = Array.from({ length: 3000 }, (_, i) => ({
      pattern: `/section-${i}/page-${i}/item`,
      target: 'static' as const,
    }));
    assert.throws(
      () =>
        buildKvsEntries({
          manifest: baseManifest({ routes }),
          buildId: 'b1',
          hasServer: false,
          hasImage: false,
        }),
      /TooManyRoutesError/,
    );
  });
});

void describe('generated request fn — glob matching (regression: mid-segment wildcards)', () => {
  const manifest = baseManifest({
    routes: [
      // mid-segment wildcard → must route to compute
      { pattern: '/api/*/admin', target: 'compute' },
      { pattern: '/api/*/data/*', target: 'compute' },
      // image-opt mid path is rare; keep a normal static + catch-all
      { pattern: '/about', target: 'static' },
      { pattern: '/*', target: 'compute' },
    ],
  });
  const entries = buildKvsEntries({
    manifest,
    buildId: 'b1',
    hasServer: true,
    hasImage: false,
  });
  const code = generateKvsRouterRequestCode();

  void it('routes /api/123/admin (mid-wildcard) to the SERVER origin', async () => {
    const { selectedOrigin } = await runRequestFn(code, entries, {
      uri: '/api/123/admin',
      headers: { host: { value: 'x.test' } },
      cookies: {},
    });
    assert.equal(selectedOrigin, ORIGIN_ID.server);
  });

  void it('routes /api/abc/data/file (double mid-wildcard) to the SERVER origin', async () => {
    const { selectedOrigin } = await runRequestFn(code, entries, {
      uri: '/api/abc/data/file',
      headers: { host: { value: 'x.test' } },
      cookies: {},
    });
    assert.equal(selectedOrigin, ORIGIN_ID.server);
  });

  void it('routes /about (static) to the S3 origin with build-id rewrite', async () => {
    const { output, selectedOrigin } = await runRequestFn(code, entries, {
      uri: '/about',
      headers: { host: { value: 'x.test' } },
      cookies: {},
    });
    assert.equal(selectedOrigin, ORIGIN_ID.s3);
    assert.match(output.uri, /^\/builds\/b1\/about/);
  });

  void it('routes /about/ (trailing slash) to S3, matching the stored /about route', async () => {
    // Regression for the bare-path drift: without trailing-slash normalization,
    // /about/ misses the table → defaults to compute on an SSR deploy.
    const { selectedOrigin } = await runRequestFn(code, entries, {
      uri: '/about/',
      headers: { host: { value: 'x.test' } },
      cookies: {},
    });
    assert.equal(selectedOrigin, ORIGIN_ID.s3);
  });
});

void describe('generated request fn — skew cookie gating', () => {
  const manifest = baseManifest({ routes: [{ pattern: '/*', target: 'static' }] });
  const reqWithCookie = {
    uri: '/page.html',
    headers: { host: { value: 'x.test' } },
    cookies: { __dpl: { value: 'oldbuild-123' } },
  };

  void it('HONORS __dpl when skew enabled (pins to cookie build)', async () => {
    const entries = buildKvsEntries({
      manifest,
      buildId: 'newbuild',
      hasServer: false,
      hasImage: false,
      skewEnabled: true,
    });
    const { output } = await runRequestFn(
      generateKvsRouterRequestCode(),
      entries,
      { ...reqWithCookie, cookies: { __dpl: { value: 'oldbuild-123' } } },
    );
    assert.match(output.uri, /^\/builds\/oldbuild-123\//);
  });

  void it('IGNORES __dpl when skew disabled (uses meta build, not the stale cookie)', async () => {
    const entries = buildKvsEntries({
      manifest,
      buildId: 'newbuild',
      hasServer: false,
      hasImage: false,
      skewEnabled: false,
    });
    const { output } = await runRequestFn(
      generateKvsRouterRequestCode(),
      entries,
      { ...reqWithCookie, cookies: { __dpl: { value: 'oldbuild-123' } } },
    );
    assert.match(output.uri, /^\/builds\/newbuild\//);
  });
});

void describe('generated response fn — per-pattern headers (mid-wildcard)', () => {
  void it('applies a header rule whose source has a mid-segment wildcard', async () => {
    const manifest = baseManifest({
      routes: [{ pattern: '/*', target: 'static' }],
      headers: [
        { source: '/api/*/admin', headers: { 'x-guard': 'on' } },
      ],
    });
    const entries = buildKvsEntries({
      manifest,
      buildId: 'b1',
      hasServer: false,
      hasImage: false,
    });
    const code = generateKvsRouterResponseCode(0).replace(
      /^import cf from 'cloudfront';\n?/,
      '',
    );
    const cf = {
      kvs: () => ({
        get: async (key: string) => {
          if (!(key in entries)) throw new Error('NoSuchKey');
          return entries[key];
        },
      }),
    };
    const factory = new Function('cf', `${code}\nreturn handler;`);
    const handler = factory(cf);
    const response = { statusCode: 200, headers: {}, cookies: {} };
    const out = await handler({
      request: { uri: '/api/9/admin' },
      response,
    });
    assert.equal(out.headers['x-guard'].value, 'on');
  });
});

void describe('generateSentinelGuardCode', () => {
  void it('returns a 403 for any request', () => {
    const code = generateSentinelGuardCode();
    const factory = new Function(`${code}\nreturn handler;`);
    const handler = factory();
    const out = handler({ request: { uri: '/__blocks_origin_server/x' } });
    assert.equal(out.statusCode, 403);
  });
});
