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
  coalesceRoutes,
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
 *
 * Uses `new Function(...)` deliberately to execute the generated function
 * source end-to-end — the source is fully repo-controlled (produced by
 * generateKvsRouterRequestCode), not external input. NOTE: under a hardened
 * runner with `--disallow-code-generation-from-strings` these helpers would
 * throw rather than silently no-op; the default `node --test` runner allows it.
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

/** Evaluate the generated viewer-RESPONSE function against a KVS map. */
async function runResponseFn(
  code: string,
  entries: Record<string, string>,
  request: Record<string, unknown>,
  response: Record<string, unknown>,
): Promise<any> {
  const cf = {
    kvs: () => ({
      get: async (key: string) => {
        if (!(key in entries)) throw new Error('NoSuchKey');
        return entries[key];
      },
    }),
  };
  const body = code.replace(/^import cf from 'cloudfront';\n?/, '');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function('cf', `${body}\nreturn handler;`);
  const handler = factory(cf);
  return handler({ request, response });
}

/** A request object with sensible defaults; override per test. */
const req = (uri: string, extra: Record<string, unknown> = {}) => ({
  uri,
  method: 'GET',
  headers: { host: { value: 'example.com' } },
  cookies: {},
  querystring: {},
  ...extra,
});

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

  void it('does NOT let a single-level * cross a segment: /api/*/data ⊄ /api/foo/bar/data', async () => {
    // Locks in the single-segment guarantee. The matched route is STATIC (S3);
    // an unmatched path on this compute deploy falls through to the implicit
    // default (server). So a single-segment middle resolves to S3, and a
    // two-segment middle — if the wildcard wrongly crossed '/' — would ALSO hit
    // S3; it must instead miss and fall through to the server origin.
    const m = baseManifest({
      routes: [
        { pattern: '/api/*/data', target: 'static' },
        { pattern: '/*', target: 'compute' }, // implicit catch-all (server)
      ],
    });
    const e = buildKvsEntries({
      manifest: m,
      buildId: 'b1',
      hasServer: true,
      hasImage: false,
    });
    // One middle segment → matches the single-level wildcard → S3.
    const hit = await runRequestFn(code, e, {
      uri: '/api/foo/data',
      headers: { host: { value: 'x.test' } },
      cookies: {},
    });
    assert.equal(hit.selectedOrigin, ORIGIN_ID.s3);
    // Two middle segments → must NOT match → falls through to the server origin.
    const miss = await runRequestFn(code, e, {
      uri: '/api/foo/bar/data',
      headers: { host: { value: 'x.test' } },
      cookies: {},
    });
    assert.equal(miss.selectedOrigin, ORIGIN_ID.server);
  });
});

void describe('generated request fn — image origin basePath strip', () => {
  // Regression: under a deployed basePath (Nuxt app.baseURL '/myapp/'), an
  // image-opt request arrives as /myapp/_ipx/... The optimizer (IPX / Next
  // image) parses the source relative to its OWN base, so the router must
  // strip basePath before forwarding — otherwise the optimizer 404s.
  const manifest = baseManifest({
    basePath: '/myapp',
    imageOptimization: { baseURL: '/_ipx' } as DeployManifest['imageOptimization'],
    routes: [
      { pattern: '/_ipx/*', target: 'image-optimization' },
      { pattern: '/*', target: 'compute' },
    ],
  });
  const entries = buildKvsEntries({
    manifest,
    buildId: 'b1',
    hasServer: true,
    hasImage: true,
  });
  const code = generateKvsRouterRequestCode();

  void it('routes /myapp/_ipx/* to the IMAGE origin with basePath stripped', async () => {
    const { output, selectedOrigin } = await runRequestFn(code, entries, {
      uri: '/myapp/_ipx/w_256/blocks-photo.png',
      headers: { host: { value: 'x.test' } },
      cookies: {},
    });
    assert.equal(selectedOrigin, ORIGIN_ID.image);
    assert.equal(output.uri, '/_ipx/w_256/blocks-photo.png');
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

// ──────────────────────────────────────────────────────────────────────────
// Added routing/caching/headers coverage (G1–G18). These EXECUTE the generated
// CloudFront Function against a KVS seeded from buildKvsEntries, covering the
// runtime branches where live bugs have occurred (assetPrefix, basePath 308,
// redirects, www↔apex, x-forwarded-host, SPA/directory-index, skew cookie) and
// the data layer (chunking, classification).
// ──────────────────────────────────────────────────────────────────────────

const reqCode = generateKvsRouterRequestCode();

void describe('request fn — G1 assetPrefix strip before classification', () => {
  const entries = buildKvsEntries({
    manifest: baseManifest({
      assetPrefix: '/cdn-static',
      routes: [
        { pattern: '/_next/static/*', target: 'static' },
        { pattern: '/*', target: 'compute' },
      ],
    }),
    buildId: 'b1',
    hasServer: true,
    hasImage: false,
  });

  void it('routes /cdn-static/_next/static/* to S3 and rewrites without the prefix', async () => {
    const { output, selectedOrigin } = await runRequestFn(
      reqCode,
      entries,
      req('/cdn-static/_next/static/chunks/main.js'),
    );
    assert.equal(selectedOrigin, ORIGIN_ID.s3);
    // prefix stripped, then build-id prefixed — NO /cdn-static in the key
    assert.equal(output.uri, '/builds/b1/_next/static/chunks/main.js');
    assert.ok(!output.uri.includes('/cdn-static'), 'assetPrefix must be stripped');
  });

  void it('a bare /_next/static request (no prefix) still resolves to S3', async () => {
    const { output, selectedOrigin } = await runRequestFn(
      reqCode,
      entries,
      req('/_next/static/chunks/main.js'),
    );
    assert.equal(selectedOrigin, ORIGIN_ID.s3);
    assert.equal(output.uri, '/builds/b1/_next/static/chunks/main.js');
  });
});

void describe('request fn — G2 basePath canonical 308', () => {
  const entries = buildKvsEntries({
    manifest: baseManifest({
      basePath: '/myapp',
      routes: [{ pattern: '/*', target: 'static' }],
    }),
    buildId: 'b1',
    hasServer: false,
    hasImage: false,
  });

  void it('redirects bare / to /myapp/ with 308', async () => {
    const { output } = await runRequestFn(reqCode, entries, req('/'));
    assert.equal(output.statusCode, 308);
    assert.equal(output.headers.location.value, '/myapp/');
  });

  void it('redirects an off-base path /about to /myapp/about with 308', async () => {
    const { output } = await runRequestFn(reqCode, entries, req('/about'));
    assert.equal(output.statusCode, 308);
    assert.equal(output.headers.location.value, '/myapp/about');
  });

  void it('does NOT redirect a request already under the base path', async () => {
    const { output, selectedOrigin } = await runRequestFn(
      reqCode,
      entries,
      req('/myapp/about'),
    );
    assert.notEqual(output.statusCode, 308);
    assert.equal(selectedOrigin, ORIGIN_ID.s3);
  });
});

void describe('request fn — G2b basePath + non-nested assetPrefix (PR review #2)', () => {
  // Regression: Next.js does NOT prefix assetPrefix with basePath. With
  // basePath '/myapp' + assetPrefix '/cdn-static' the browser fetches
  // /cdn-static/_next/static/* (no /myapp). The basePath 308 used to fire on
  // that (it isn't under /myapp) and redirect to /myapp/cdn-static/... → 404 →
  // browser rejects the HTML 404 as a non-executable script. The assetPrefix
  // strip must run FIRST and the stripped asset must SKIP the basePath 308.
  const entries = buildKvsEntries({
    manifest: baseManifest({
      basePath: '/myapp',
      assetPrefix: '/cdn-static',
      routes: [
        { pattern: '/_next/static/*', target: 'static' },
        { pattern: '/*', target: 'compute' },
      ],
    }),
    buildId: 'b1',
    hasServer: true,
    hasImage: false,
  });

  void it('serves a prefixed asset from S3 (NO 308) when basePath is also set', async () => {
    const { output, selectedOrigin } = await runRequestFn(
      reqCode,
      entries,
      req('/cdn-static/_next/static/chunks/main.js'),
    );
    // The bug: this used to be a 308 to /myapp/cdn-static/... (or /myapp/_next).
    assert.notEqual(
      output.statusCode,
      308,
      'prefixed asset must NOT be basePath-redirected',
    );
    assert.equal(selectedOrigin, ORIGIN_ID.s3);
    assert.equal(output.uri, '/builds/b1/_next/static/chunks/main.js');
    assert.ok(!output.uri.includes('/cdn-static'));
    assert.ok(!output.uri.includes('/myapp'));
  });

  void it('still 308-redirects a normal off-base page to the basePath', async () => {
    const { output } = await runRequestFn(reqCode, entries, req('/about'));
    assert.equal(output.statusCode, 308);
    assert.equal(output.headers.location.value, '/myapp/about');
  });

  void it('still 308-redirects the bare root to /myapp/', async () => {
    const { output } = await runRequestFn(reqCode, entries, req('/'));
    assert.equal(output.statusCode, 308);
    assert.equal(output.headers.location.value, '/myapp/');
  });
});

void describe('request fn — G2c basePath route table is single-prefixed & not over-coalesced', () => {
  // Regression (basePath double-prefix + coalesce-shadow): when the adapter
  // already emits basePath-relative patterns, buildKvsEntries must (a) prepend
  // basePath EXACTLY ONCE (never /app/app/...) and (b) coalesce on the RELATIVE
  // patterns so root-level Next routes (/_next/*, /blocks-logo.png, /BUILD_ID —
  // root parent '') are NOT collapsed into a single /app/* static wildcard that
  // would shadow every dynamic SSR page under basePath. See kvs_router.ts.
  const entries = buildKvsEntries({
    manifest: baseManifest({
      basePath: '/app',
      routes: [
        { pattern: '/_next/image*', target: 'image-optimization' },
        { pattern: '/_next/data/*', target: 'compute' },
        { pattern: '/_next/*', target: 'static' },
        { pattern: '/blocks-logo.png', target: 'static' },
        { pattern: '/BUILD_ID', target: 'static' },
        { pattern: '/*', target: 'compute' },
      ],
    }),
    buildId: 'b1',
    hasServer: true,
    hasImage: true,
  });

  void it('prepends basePath exactly once (no /app/app/ double prefix)', () => {
    const rows = JSON.parse(entries.r0) as [string, string][];
    for (const [pattern] of rows) {
      assert.ok(
        pattern.startsWith('/app/'),
        `row ${pattern} must be under /app`,
      );
      assert.ok(
        !pattern.startsWith('/app/app/'),
        `row ${pattern} must NOT be double-prefixed`,
      );
    }
  });

  void it('keeps individual root-level static rows (no /app/* over-coalesce)', () => {
    const rows = JSON.parse(entries.r0) as [string, string][];
    const patterns = rows.map(([p]) => p);
    // The bug would collapse all of these into one `/app/*` static row.
    assert.ok(!patterns.includes('/app/*'), 'must not collapse to /app/*');
    assert.ok(patterns.includes('/app/_next/*'));
    assert.ok(patterns.includes('/app/blocks-logo.png'));
  });

  void it('serves a basePath asset from S3 (the reported 404 path)', async () => {
    const { output, selectedOrigin } = await runRequestFn(
      reqCode,
      entries,
      req('/app/_next/static/chunks/webpack.js'),
    );
    assert.equal(selectedOrigin, ORIGIN_ID.s3);
    assert.equal(output.uri, '/builds/b1/_next/static/chunks/webpack.js');
  });

  void it('routes a dynamic SSR page under basePath to COMPUTE (not shadowed by static)', async () => {
    const { output, selectedOrigin } = await runRequestFn(
      reqCode,
      entries,
      req('/app/api/echo'),
    );
    assert.equal(
      selectedOrigin,
      ORIGIN_ID.server,
      'dynamic route must reach the SSR origin, not S3',
    );
    assert.equal(output.uri, '/app/api/echo');
  });

  void it('still coalesces a genuine SSG fan-out under basePath (instruction-limit guard)', () => {
    const many = baseManifest({
      basePath: '/app',
      routes: [
        ...Array.from({ length: 50 }, (_, i) => ({
          pattern: `/blog/post-${i}`,
          target: 'static' as const,
        })),
        { pattern: '/*', target: 'compute' as const },
      ],
    });
    const e = buildKvsEntries({
      manifest: many,
      buildId: 'b1',
      hasServer: true,
      hasImage: false,
    });
    const rows = JSON.parse(e.r0) as [string, string][];
    const patterns = rows.map(([p]) => p);
    assert.ok(
      patterns.includes('/app/blog/*'),
      'SSG fan-out must coalesce to /app/blog/*',
    );
    assert.ok(
      !patterns.includes('/app/blog/post-5'),
      'individual fan-out rows must be collapsed',
    );
  });
});

void describe('request fn — G3 redirects (exact + wildcard tail splice)', () => {
  const entries = buildKvsEntries({
    manifest: baseManifest({
      routes: [{ pattern: '/*', target: 'static' }],
      redirects: [
        { source: '/old-page', destination: '/new-page', statusCode: 308 },
        { source: '/legacy/*', destination: '/modern/*', statusCode: 301 },
        { source: '/temp', destination: '/home', statusCode: 302 },
      ],
    }),
    buildId: 'b1',
    hasServer: false,
    hasImage: false,
  });

  void it('exact redirect returns the configured status + destination', async () => {
    const { output } = await runRequestFn(reqCode, entries, req('/old-page'));
    assert.equal(output.statusCode, 308);
    assert.equal(output.headers.location.value, '/new-page');
  });

  void it('wildcard redirect splices the captured tail into the destination', async () => {
    const { output } = await runRequestFn(reqCode, entries, req('/legacy/a/b'));
    assert.equal(output.statusCode, 301);
    assert.equal(output.headers.location.value, '/modern/a/b');
  });

  void it('preserves a 302 (temporary) status code', async () => {
    const { output } = await runRequestFn(reqCode, entries, req('/temp'));
    assert.equal(output.statusCode, 302);
    assert.equal(output.headers.location.value, '/home');
  });
});

void describe('request fn — G4 www↔apex canonical 301', () => {
  const toApex = buildKvsEntries({
    manifest: baseManifest({ routes: [{ pattern: '/*', target: 'static' }] }),
    buildId: 'b1',
    hasServer: false,
    hasImage: false,
    wwwRedirect: 'toApex',
  });
  const toWww = buildKvsEntries({
    manifest: baseManifest({ routes: [{ pattern: '/*', target: 'static' }] }),
    buildId: 'b1',
    hasServer: false,
    hasImage: false,
    wwwRedirect: 'toWww',
  });

  void it('toApex: www.example.com → example.com (301), preserves path + query', async () => {
    const { output } = await runRequestFn(reqCode, toApex, {
      ...req('/p'),
      headers: { host: { value: 'www.example.com' } },
      querystring: { a: { value: '1' } },
    });
    assert.equal(output.statusCode, 301);
    assert.equal(output.headers.location.value, 'https://example.com/p?a=1');
  });

  void it('toWww: example.com → www.example.com (301)', async () => {
    const { output } = await runRequestFn(reqCode, toWww, {
      ...req('/p'),
      headers: { host: { value: 'example.com' } },
    });
    assert.equal(output.statusCode, 301);
    assert.equal(output.headers.location.value, 'https://www.example.com/p');
  });

  void it('toApex: an apex request is NOT redirected', async () => {
    const { output } = await runRequestFn(reqCode, toApex, {
      ...req('/p'),
      headers: { host: { value: 'example.com' } },
    });
    assert.notEqual(output.statusCode, 301);
  });
});

void describe('request fn — G5 already-prefixed /builds/ passthrough', () => {
  const entries = buildKvsEntries({
    manifest: baseManifest({ routes: [{ pattern: '/*', target: 'compute' }] }),
    buildId: 'b1',
    hasServer: true,
    hasImage: false,
  });
  void it('sends /builds/<id>/page straight to S3 unchanged (no re-prefix/redirect)', async () => {
    const { output, selectedOrigin } = await runRequestFn(
      reqCode,
      entries,
      req('/builds/b1/about/index.html'),
    );
    assert.equal(selectedOrigin, ORIGIN_ID.s3);
    assert.equal(output.uri, '/builds/b1/about/index.html');
  });
});

void describe('request fn — G6 compute origin sets x-forwarded-host', () => {
  const entries = buildKvsEntries({
    manifest: baseManifest({
      routes: [
        { pattern: '/api/*', target: 'compute' },
        { pattern: '/*', target: 'static' },
      ],
    }),
    buildId: 'b1',
    hasServer: true,
    hasImage: false,
  });
  void it('selects server origin, keeps URI, injects Host → x-forwarded-host', async () => {
    const { output, selectedOrigin } = await runRequestFn(
      reqCode,
      entries,
      { ...req('/api/users'), headers: { host: { value: 'example.com' } } },
    );
    assert.equal(selectedOrigin, ORIGIN_ID.server);
    assert.equal(output.uri, '/api/users'); // unchanged, no build-id prefix
    assert.equal(output.headers['x-forwarded-host'].value, 'example.com');
  });
});

void describe('request fn — G7 SPA fallback (spa=1)', () => {
  const entries = buildKvsEntries({
    manifest: baseManifest({
      staticAssets: { directory: '/tmp', spaFallback: true },
      routes: [{ pattern: '/*', target: 'static' }],
    }),
    buildId: 'b1',
    hasServer: false,
    hasImage: false,
  });
  void it('rewrites an extensionless deep link to /index.html', async () => {
    const { output } = await runRequestFn(reqCode, entries, req('/dashboard/settings'));
    assert.equal(output.uri, '/builds/b1/index.html');
  });
  void it('serves a real asset (has extension) directly, not the SPA shell', async () => {
    const { output } = await runRequestFn(reqCode, entries, req('/logo.svg'));
    assert.equal(output.uri, '/builds/b1/logo.svg');
  });
  void it('does NOT SPA-fallback a /.well-known/ path', async () => {
    const { output } = await runRequestFn(
      reqCode,
      entries,
      req('/.well-known/acme-challenge/tok'),
    );
    assert.equal(output.uri, '/builds/b1/.well-known/acme-challenge/tok');
  });
});

void describe('request fn — G8 directory-index (spa=0)', () => {
  const entries = buildKvsEntries({
    manifest: baseManifest({
      staticAssets: { directory: '/tmp', spaFallback: false },
      routes: [{ pattern: '/*', target: 'static' }],
    }),
    buildId: 'b1',
    hasServer: false,
    hasImage: false,
  });
  void it('appends /index.html to a trailing-slash path', async () => {
    const { output } = await runRequestFn(reqCode, entries, req('/about/'));
    assert.equal(output.uri, '/builds/b1/about/index.html');
  });
  void it('appends /index.html to an extensionless path', async () => {
    const { output } = await runRequestFn(reqCode, entries, req('/about'));
    assert.equal(output.uri, '/builds/b1/about/index.html');
  });
  void it('serves a file with an extension directly', async () => {
    const { output } = await runRequestFn(reqCode, entries, req('/style.css'));
    assert.equal(output.uri, '/builds/b1/style.css');
  });
});

void describe('request fn — bare prerendered route under basePath → S3 (Issue 1)', () => {
  // Regression: a Nuxt `prerender: true` page (e.g. /about) under basePath
  // /myapp must serve the FROZEN prerendered HTML from S3, not be re-rendered
  // by the SSR Lambda. The adapter now emits a bare `/about` static route (+
  // `/about/*`); the router strips basePath, classifies it static, and the
  // directory-index branch resolves the extensionless bare path to
  // /builds/<id>/about/index.html (how Nuxt prerenders it).
  const entries = buildKvsEntries({
    manifest: baseManifest({
      basePath: '/myapp',
      staticAssets: { directory: '/tmp', spaFallback: false },
      routes: [
        { pattern: '/about', target: 'static' },
        { pattern: '/about/*', target: 'static' },
        { pattern: '/*', target: 'compute' },
      ],
    }),
    buildId: 'b1',
    hasServer: true,
    hasImage: false,
  });
  void it('routes bare /myapp/about to S3 + rewrites to the frozen index.html', async () => {
    const { output, selectedOrigin } = await runRequestFn(
      reqCode,
      entries,
      req('/myapp/about'),
    );
    assert.equal(selectedOrigin, ORIGIN_ID.s3);
    assert.equal(output.uri, '/builds/b1/about/index.html');
  });
});

void describe('request fn — G10 fail-open when meta is missing', () => {
  void it('returns the request unchanged (no origin selected) if KVS has no meta', async () => {
    const { output, selectedOrigin } = await runRequestFn(reqCode, {}, req('/x'));
    assert.equal(selectedOrigin, null);
    assert.equal(output.uri, '/x'); // untouched — fail open, don't 5xx
  });
});

void describe('request fn — G11 default kind when no route matches', () => {
  void it('defaults to SERVER when a compute origin exists', async () => {
    const entries = buildKvsEntries({
      manifest: baseManifest({ routes: [{ pattern: '/known', target: 'static' }] }),
      buildId: 'b1',
      hasServer: true,
      hasImage: false,
    });
    const { selectedOrigin } = await runRequestFn(reqCode, entries, req('/unknown-path'));
    assert.equal(selectedOrigin, ORIGIN_ID.server);
  });
  void it('defaults to S3 when there is no compute origin', async () => {
    const entries = buildKvsEntries({
      manifest: baseManifest({ routes: [{ pattern: '/known', target: 'static' }] }),
      buildId: 'b1',
      hasServer: false,
      hasImage: false,
    });
    const { selectedOrigin } = await runRequestFn(reqCode, entries, req('/unknown-path'));
    assert.equal(selectedOrigin, ORIGIN_ID.s3);
  });
});

void describe('response fn — G12/G13 skew cookie set semantics', () => {
  const entries = buildKvsEntries({
    manifest: baseManifest({ routes: [{ pattern: '/*', target: 'static' }] }),
    buildId: 'build-XYZ',
    hasServer: false,
    hasImage: false,
  });

  void it('sets __dpl=buildId on a 200 text/html response (enabled)', async () => {
    const out = await runResponseFn(
      generateKvsRouterResponseCode(86400),
      entries,
      { uri: '/' },
      { statusCode: 200, headers: { 'content-type': { value: 'text/html; charset=utf-8' } }, cookies: {} },
    );
    assert.ok(out.cookies['__dpl'], '__dpl cookie should be set');
    assert.equal(out.cookies['__dpl'].value, 'build-XYZ');
    assert.match(out.cookies['__dpl'].attributes, /Max-Age=86400/);
  });

  void it('does NOT set __dpl on a non-HTML (e.g. image) response', async () => {
    const out = await runResponseFn(
      generateKvsRouterResponseCode(86400),
      entries,
      { uri: '/logo.png' },
      { statusCode: 200, headers: { 'content-type': { value: 'image/png' } }, cookies: {} },
    );
    assert.ok(!out.cookies['__dpl'], 'no cookie on non-HTML');
  });

  void it('does NOT set __dpl on a 5xx HTML error response', async () => {
    const out = await runResponseFn(
      generateKvsRouterResponseCode(86400),
      entries,
      { uri: '/' },
      { statusCode: 500, headers: { 'content-type': { value: 'text/html' } }, cookies: {} },
    );
    assert.ok(!out.cookies['__dpl'], 'no cookie on 5xx');
  });

  void it('NEVER sets __dpl when skew disabled (maxAge=0), even on 200 HTML', async () => {
    const out = await runResponseFn(
      generateKvsRouterResponseCode(0),
      entries,
      { uri: '/' },
      { statusCode: 200, headers: { 'content-type': { value: 'text/html' } }, cookies: {} },
    );
    assert.ok(!out.cookies['__dpl'], 'cookie must not be set when disabled');
  });
});

void describe('response fn — G14 per-pattern headers (exact + multi + lowercase)', () => {
  const entries = buildKvsEntries({
    manifest: baseManifest({
      routes: [{ pattern: '/*', target: 'static' }],
      headers: [
        {
          source: '/secure-headers',
          headers: {
            'X-Frame-Options': 'DENY',
            'Strict-Transport-Security': 'max-age=63072000',
          },
        },
        { source: '/api/*', headers: { 'x-api': 'yes' } },
      ],
    }),
    buildId: 'b1',
    hasServer: false,
    hasImage: false,
  });
  const respCode = generateKvsRouterResponseCode(0);

  void it('applies multiple headers (lowercased) on an exact match', async () => {
    const out = await runResponseFn(respCode, entries, { uri: '/secure-headers' }, {
      statusCode: 200,
      headers: {},
      cookies: {},
    });
    assert.equal(out.headers['x-frame-options'].value, 'DENY');
    assert.equal(out.headers['strict-transport-security'].value, 'max-age=63072000');
  });
  void it('applies a wildcard header rule', async () => {
    const out = await runResponseFn(respCode, entries, { uri: '/api/users' }, {
      statusCode: 200,
      headers: {},
      cookies: {},
    });
    assert.equal(out.headers['x-api'].value, 'yes');
  });
  void it('does NOT apply header rules to a non-matching path', async () => {
    const out = await runResponseFn(respCode, entries, { uri: '/other' }, {
      statusCode: 200,
      headers: {},
      cookies: {},
    });
    assert.ok(!out.headers['x-frame-options'], 'no header on non-match');
  });
});

void describe('buildKvsEntries — G15 chunking & round-trip', () => {
  void it('chunks a large route table and the meta.rc count matches; reassembly is lossless', () => {
    const routes = Array.from({ length: 300 }, (_, i) => ({
      pattern: `/section-${i}/page`,
      target: 'static' as const,
    }));
    const entries = buildKvsEntries({
      manifest: baseManifest({ routes }),
      buildId: 'b1',
      hasServer: false,
      hasImage: false,
    });
    const meta = JSON.parse(entries.meta);
    // every advertised chunk exists
    for (let i = 0; i < meta.rc; i++) {
      assert.ok(entries[`r${i}`] !== undefined, `chunk r${i} present`);
      assert.ok(
        Buffer.byteLength(entries[`r${i}`], 'utf8') <= 1024,
        `chunk r${i} under the 1KB KVS value limit`,
      );
    }
    // reassemble all chunks → must contain every route pattern
    const reassembled: [string, string][] = [];
    for (let i = 0; i < meta.rc; i++) reassembled.push(...JSON.parse(entries[`r${i}`]));
    assert.equal(reassembled.length, routes.length, 'no rows lost across chunks');
    assert.ok(reassembled.some((r) => r[0] === '/section-299/page'), 'last route survived');
  });
});

void describe('buildKvsEntries — edge route exclusion', () => {
  // OpenNext `runtime:'edge'` routes are served by dedicated CloudFront
  // behaviors with a Lambda@Edge attached; they must NOT appear in the KVS
  // route table, or the router would send them to the default server Lambda
  // (which lacks the split routes) → 500.
  void it('omits edge-target routes from the KVS table', () => {
    const entries = buildKvsEntries({
      manifest: baseManifest({
        routes: [
          { pattern: '/edge', target: 'edge2' },
          { pattern: '/api/edge', target: 'edge1' },
          { pattern: '/api/normal', target: 'default' },
          { pattern: '/*', target: 'static' },
        ],
      }),
      buildId: 'b1',
      hasServer: true,
      hasImage: false,
      edgeTargets: new Set(['edge1', 'edge2']),
    });
    const meta = JSON.parse(entries.meta);
    const rows: [string, string][] = [];
    for (let i = 0; i < meta.rc; i++) rows.push(...JSON.parse(entries[`r${i}`]));
    const patterns = rows.map((r) => r[0]);
    assert.ok(!patterns.includes('/edge'), '/edge must be excluded');
    assert.ok(!patterns.includes('/api/edge'), '/api/edge must be excluded');
    assert.ok(patterns.includes('/api/normal'), 'non-edge routes remain');
  });

  void it('keeps all routes when no edgeTargets are given (default)', () => {
    const entries = buildKvsEntries({
      manifest: baseManifest({
        routes: [
          { pattern: '/edge', target: 'edge2' },
          { pattern: '/*', target: 'static' },
        ],
      }),
      buildId: 'b1',
      hasServer: true,
      hasImage: false,
    });
    const rows: [string, string][] = [];
    const meta = JSON.parse(entries.meta);
    for (let i = 0; i < meta.rc; i++) rows.push(...JSON.parse(entries[`r${i}`]));
    assert.ok(rows.some((r) => r[0] === '/edge'), 'without edgeTargets, /edge is kept');
  });
});

void describe('buildKvsEntries — G17 image classification', () => {
  void it("classifies target:'image-optimization' as kind 'i' when hasImage", () => {
    const entries = buildKvsEntries({
      manifest: baseManifest({
        imageOptimization: { baseURL: '/_ipx' } as DeployManifest['imageOptimization'],
        routes: [
          { pattern: '/_next/image*', target: 'image-optimization' },
          { pattern: '/*', target: 'static' },
        ],
      }),
      buildId: 'b1',
      hasServer: false,
      hasImage: true,
    });
    const rows = JSON.parse(entries.r0) as [string, string][];
    const img = rows.find((r) => r[0] === '/_next/image*');
    assert.ok(img, 'image route present');
    assert.equal(img![1], 'i');
  });

  void it("does NOT classify as image when hasImage=false (falls to compute/static)", () => {
    const entries = buildKvsEntries({
      manifest: baseManifest({
        routes: [
          { pattern: '/_next/image*', target: 'image-optimization' },
          { pattern: '/*', target: 'static' },
        ],
      }),
      buildId: 'b1',
      hasServer: true,
      hasImage: false,
    });
    const rows = JSON.parse(entries.r0) as [string, string][];
    const img = rows.find((r) => r[0] === '/_next/image*');
    assert.ok(img && img[1] !== 'i', "must not be kind 'i' when no image origin");
  });
});

void describe('coalesceRoutes — bound SSG fan-out for the edge scan', () => {
  void it('collapses many same-kind siblings under one parent into parent/*', () => {
    const rows: [string, 's'][] = Array.from({ length: 100 }, (_, i) => [
      `/stress/${i}/*`,
      's',
    ]);
    const out = coalesceRoutes(rows);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], ['/stress/*', 's']);
  });

  void it('also collapses the bare + subtree pair Nuxt emits per page', () => {
    // Nuxt emits BOTH `/stress/N` and `/stress/N/*` per prerendered page.
    const rows: [string, 's'][] = [];
    for (let i = 0; i < 50; i++) {
      rows.push([`/stress/${i}`, 's']);
      rows.push([`/stress/${i}/*`, 's']);
    }
    const out = coalesceRoutes(rows);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], ['/stress/*', 's']);
  });

  void it('dedupes the duplicate wildcard from coalescing bare + subtree forms', () => {
    // Nuxt emits `/stress/N` AND `/stress/N/*`; both forms coalesce to
    // `/stress/*`, so the result must contain it exactly ONCE.
    const rows: [string, 's'][] = [
      ['/stress/0', 's'],
      ['/stress/0/*', 's'],
      ['/stress/1', 's'],
      ['/stress/1/*', 's'],
    ];
    const out = coalesceRoutes(rows);
    assert.deepEqual(out, [['/stress/*', 's']]);
  });

  void it('does NOT coalesce when sibling kinds differ (mixed static/compute)', () => {
    const rows: [string, 's' | 'c'][] = [
      ['/mix/a', 's'],
      ['/mix/b', 'c'],
      ['/mix/c', 's'],
    ];
    const out = coalesceRoutes(rows);
    // Mixed kind under /mix → left as individual rows (no lossy wildcard).
    assert.equal(out.length, 3);
    assert.ok(!out.some(([p]) => p === '/mix/*'));
  });

  void it('retains a deeper differently-kinded route alongside a coalesced group', () => {
    // /blog/* (static pages) coalesces, but /blog/x/admin (compute) is under a
    // DIFFERENT parent (/blog/x) so it is never folded in, and its extra
    // literal segment sorts it ahead of /blog/* in buildKvsEntries.
    const rows: [string, 's' | 'c'][] = [
      ['/blog/p1', 's'],
      ['/blog/p2', 's'],
      ['/blog/p3', 's'],
      ['/blog/x/admin', 'c'],
    ];
    const out = coalesceRoutes(rows);
    assert.ok(out.some(([p, k]) => p === '/blog/*' && k === 's'));
    assert.ok(out.some(([p, k]) => p === '/blog/x/admin' && k === 'c'));
  });

  void it('leaves a single route untouched (no spurious wildcard)', () => {
    const rows: [string, 's'][] = [['/about', 's']];
    const out = coalesceRoutes(rows);
    assert.deepEqual(out, [['/about', 's']]);
  });

  void it('never coalesces top-level routes into a site-wide /*', () => {
    // Root-level siblings (parent === '') must NOT become `/*` — that would
    // swallow every path. They stay as individual rows.
    const rows: [string, 's'][] = [
      ['/about', 's'],
      ['/contact', 's'],
      ['/pricing', 's'],
    ];
    const out = coalesceRoutes(rows);
    assert.equal(out.length, 3);
    assert.ok(!out.some(([p]) => p === '/*'));
  });

  void it('bounds the route-chunk count for a large SSG deploy (regression)', () => {
    // 200 prerendered pages under /stress used to need ~7 r-chunks → 7
    // JSON.parse per request → instruction-limit 503 on the root path. After
    // coalescing they are one row → one chunk.
    const routes = [
      ...Array.from({ length: 200 }, (_, i) => ({
        pattern: `/stress/${i}/*`,
        target: 'static',
      })),
      { pattern: '/*', target: 'compute' },
    ];
    const entries = buildKvsEntries({
      manifest: baseManifest({
        compute: { default: { type: 'handler', bundle: '/tmp', handler: 'h', placement: 'regional' } },
        staticAssets: { directory: '/tmp', spaFallback: false },
        routes,
      }),
      buildId: 'b1',
      hasServer: true,
      hasImage: false,
    });
    const meta = JSON.parse(entries.meta) as { rc: number };
    assert.equal(meta.rc, 1, 'coalesced SSG fan-out must fit in a single route chunk');
  });
});
