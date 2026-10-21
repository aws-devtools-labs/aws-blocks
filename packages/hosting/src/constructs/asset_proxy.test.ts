// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Behaviour of the inline asset-proxy Lambdas the ALB and API Gateway doors
 * serve static files through. They must answer like the CloudFront static
 * path: a missing file 404s (the SPA fallback is for extensionless paths
 * only), and each object is served with its own stored `Cache-Control`.
 *
 * The generated source is executed against an in-memory S3 stub.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as zlib from 'node:zlib';
import { generateAlbAssetProxyCode } from './alb_asset_proxy.js';
import { generateApiGwAssetProxyCode } from './apigw_asset_proxy.js';

type StoredObject = {
  body: string;
  contentType?: string;
  cacheControl?: string;
  fails?: number;
  etag?: string;
  lastModified?: Date;
};
type GetInput = { Bucket: string; Key: string; IfNoneMatch?: string; IfModifiedSince?: Date };
type ProxyResponse = { statusCode: number; headers: Record<string, string>; body: string; isBase64Encoded: boolean };
type ProxyHandler = (event: Record<string, unknown>) => Promise<ProxyResponse>;

const PREFIX = 'builds/b1';

/** Load a generated handler with `@aws-sdk/client-s3` replaced by an in-memory bucket. */
const loadHandler = (code: string, objects: Record<string, StoredObject>, reads: GetInput[] = []): ProxyHandler => {
  class GetObjectCommand {
    constructor(readonly input: GetInput) {}
  }
  class S3Client {
    async send(cmd: GetObjectCommand) {
      reads.push(cmd.input);
      const obj = objects[cmd.input.Key];
      if (!obj) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      if (obj.fails) {
        throw Object.assign(new Error('S3 failed'), { name: 'InternalError', $metadata: { httpStatusCode: obj.fails } });
      }
      if (obj.etag && cmd.input.IfNoneMatch === obj.etag) {
        throw Object.assign(new Error('Not Modified'), { name: '304', $metadata: { httpStatusCode: 304 } });
      }
      return {
        Body: [Buffer.from(obj.body)],
        ContentType: obj.contentType,
        CacheControl: obj.cacheControl,
        ETag: obj.etag,
        LastModified: obj.lastModified,
      };
    }
  }
  const mod: { exports: { handler?: ProxyHandler } } = { exports: {} };
  const fakeRequire = (id: string) => {
    if (id === '@aws-sdk/client-s3') return { S3Client, GetObjectCommand };
    if (id === 'node:zlib') return zlib;
    throw new Error(`unexpected require: ${id}`);
  };
  const fakeProcess = { env: { ASSET_BUCKET: 'bucket', ASSET_KEY_PREFIX: PREFIX } };
  new Function('require', 'exports', 'module', 'process', code)(fakeRequire, mod.exports, mod, fakeProcess);
  const handler = mod.exports.handler;
  if (!handler) throw new Error('generated code exports no handler');
  return handler;
};

const OBJECTS: Record<string, StoredObject> = {
  [`${PREFIX}/index.html`]: { body: '<html>shell</html>', contentType: 'text/html', cacheControl: 'no-cache' },
  [`${PREFIX}/assets/app-abc123.js`]: {
    body: 'js',
    contentType: 'text/javascript',
    cacheControl: 'public, max-age=31536000, immutable',
  },
  [`${PREFIX}/.blocks-sandbox/config.json`]: {
    body: '{}',
    contentType: 'application/json',
    cacheControl: 'max-age=60, must-revalidate',
  },
  [`${PREFIX}/robots.txt`]: { body: 'User-agent: *', contentType: 'text/plain' },
};

const decode = (res: ProxyResponse): string =>
  res.isBase64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;

type ProxyOptions = Parameters<typeof generateAlbAssetProxyCode>[0];
type EventFor = (path: string, headers?: Record<string, string>) => Record<string, unknown>;
const variants: Array<[string, (opts: ProxyOptions) => string, EventFor]> = [
  ['ALB', (o) => generateAlbAssetProxyCode(o), (path, headers = {}) => ({ path, httpMethod: 'GET', headers })],
  [
    'API Gateway HTTP (payload 2.0)',
    (o) => generateApiGwAssetProxyCode(o),
    (path, headers = {}) => ({ rawPath: path, headers, requestContext: { http: { method: 'GET', path } } }),
  ],
  [
    'API Gateway REST (payload 1.0)',
    (o) => generateApiGwAssetProxyCode(o),
    // A REST API keeps the header names as the client sent them.
    (path, headers = {}) => ({
      path,
      httpMethod: 'GET',
      headers: Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.replace(/(^|-)([a-z])/g, (_m, d, c) => d + c.toUpperCase()), v]),
      ),
    }),
  ],
];

for (const [label, generate, event] of variants) {
  describe(`${label} asset proxy — parity with the CloudFront static path`, () => {
    const spa = loadHandler(generate({ spaFallback: true }), OBJECTS);

    it('serves the SPA shell for an extensionless deep link', async () => {
      const res = await spa(event('/dashboard/settings'));
      assert.equal(res.statusCode, 200);
      assert.equal(decode(res), '<html>shell</html>');
    });

    it('returns 404 (not the SPA shell) for a missing file that has an extension', async () => {
      for (const path of ['/missing-file.js', '/.env', '/assets/gone-123.css']) {
        const res = await spa(event(path));
        assert.equal(res.statusCode, 404, `${path} should 404`);
        assert.notEqual(decode(res), '<html>shell</html>', `${path} must not serve index.html`);
      }
    });

    it('returns 404 for a missing /.well-known/ path (no SPA fallback there, like CloudFront)', async () => {
      const res = await spa(event('/.well-known/apple-app-site-association'));
      assert.equal(res.statusCode, 404);
    });

    it("passes through the object's stored Cache-Control", async () => {
      const config = await spa(event('/.blocks-sandbox/config.json'));
      assert.equal(config.statusCode, 200);
      assert.equal(config.headers['cache-control'], 'max-age=60, must-revalidate');
      const hashed = await spa(event('/assets/app-abc123.js'));
      assert.equal(hashed.headers['cache-control'], 'public, max-age=31536000, immutable');
      const shell = await spa(event('/'));
      assert.equal(shell.headers['cache-control'], 'no-cache');
    });

    it('falls back to a default Cache-Control only when the object has none', async () => {
      const res = await spa(event('/robots.txt'));
      assert.equal(res.statusCode, 200);
      assert.ok(res.headers['cache-control'], 'a default cache-control is set');
      assert.doesNotMatch(res.headers['cache-control'], /immutable/, 'an unhashed file is not served immutable');
    });

    it('multi-page (no SPA fallback): a missing page is a 404', async () => {
      const mpa = loadHandler(generate({ spaFallback: false }), OBJECTS);
      const res = await mpa(event('/no-such-page'));
      assert.equal(res.statusCode, 404);
    });
  });
}

// ── The app's rules: redirects, header rules, error pages ──────────────────
// The same semantics as the CloudFront door (matched by the edge router's own
// code): first redirect wins with the wildcard tail spliced, every matching
// header rule applies to a successful response, and a missing file serves the
// app's 404 page (an S3 failure its 500 page).

const RULE_OBJECTS: Record<string, StoredObject> = {
  ...OBJECTS,
  [`${PREFIX}/404.html`]: { body: '<h1>custom not found</h1>', contentType: 'text/html' },
  [`${PREFIX}/500.html`]: { body: '<h1>custom server error</h1>', contentType: 'text/html' },
  [`${PREFIX}/assets/broken.js`]: { body: '', fails: 503 },
};
const RULES: ProxyOptions = {
  spaFallback: true,
  redirects: [
    { source: '/old/*', destination: '/new/*', statusCode: 301 },
    { source: '/legacy', destination: '/', statusCode: 302 },
  ],
  headers: [
    { pattern: '/assets/*', headers: { 'X-Asset-Rule': 'assets' } },
    { pattern: '/*', headers: { 'X-Site-Rule': 'site' } },
  ],
  errorPages: { notFound: '404.html', serverError: '500.html' },
};

for (const [label, generate, event] of variants) {
  describe(`${label} asset proxy — the app's redirects, header rules and error pages`, () => {
    const proxy = loadHandler(generate(RULES), RULE_OBJECTS);

    it('redirects a wildcard source with its tail spliced into the destination', async () => {
      const res = await proxy(event('/old/blog/post-1'));
      assert.equal(res.statusCode, 301);
      assert.equal(res.headers.location, '/new/blog/post-1');
      // A redirect is answered before the origin, so (as at the edge) no header rule applies.
      assert.equal(res.headers['x-site-rule'], undefined);
    });

    it('redirects an exact source', async () => {
      const res = await proxy(event('/legacy'));
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.location, '/');
    });

    it('applies every matching header rule to a served file (names lower-cased)', async () => {
      const res = await proxy(event('/assets/app-abc123.js'));
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['x-asset-rule'], 'assets');
      assert.equal(res.headers['x-site-rule'], 'site');
      const shell = await proxy(event('/dashboard'));
      assert.equal(shell.headers['x-site-rule'], 'site');
      assert.equal(shell.headers['x-asset-rule'], undefined);
    });

    it('serves the app 404 page, with status 404, for a missing file', async () => {
      const res = await proxy(event('/assets/gone-123.css'));
      assert.equal(res.statusCode, 404);
      assert.equal(decode(res), '<h1>custom not found</h1>');
      assert.match(res.headers['content-type'], /^text\/html/);
      // As at the edge, header rules apply to successful responses only.
      assert.equal(res.headers['x-asset-rule'], undefined);
    });

    it('serves the app 500 page, with status 500, when S3 fails', async () => {
      const res = await proxy(event('/assets/broken.js'));
      assert.equal(res.statusCode, 500);
      assert.equal(decode(res), '<h1>custom server error</h1>');
    });

    it('no rules: no redirect, no extra headers, a plain 404', async () => {
      const plain = loadHandler(generate({ spaFallback: true }), RULE_OBJECTS);
      const miss = await plain(event('/assets/gone-123.css'));
      assert.equal(miss.statusCode, 404);
      assert.equal(decode(miss), 'Not Found');
      const old = await plain(event('/old/blog/post-1'));
      assert.equal(old.statusCode, 200, 'an extensionless path serves the SPA shell');
      assert.equal(old.headers['x-site-rule'], undefined);
    });
  });
}

// ── Request paths, compression, validators, the error-page cache ───────────

const BIG_JS = `export const data = ${JSON.stringify('x'.repeat(4096))};`;
const PATH_OBJECTS: Record<string, StoredObject> = {
  ...RULE_OBJECTS,
  [`${PREFIX}/docs/My Resume.pdf`]: { body: 'pdf', contentType: 'application/pdf' },
  [`${PREFIX}/docs/caf\u00e9.txt`]: { body: 'utf8 name', contentType: 'text/plain' },
  [`${PREFIX}/assets/big-abc.js`]: {
    body: BIG_JS,
    contentType: 'text/javascript',
    cacheControl: 'public, max-age=31536000, immutable',
    etag: '"big-etag"',
    lastModified: new Date('2026-01-02T03:04:05Z'),
  },
  [`${PREFIX}/fonts/a.woff2`]: { body: 'w'.repeat(4096), contentType: 'font/woff2', etag: '"font-etag"' },
};

for (const [label, generate, event] of variants) {
  describe(`${label} asset proxy — request paths, compression and validators`, () => {
    it('percent-decodes the request path before the S3 lookup', async () => {
      const proxy = loadHandler(generate({ spaFallback: false }), PATH_OBJECTS);
      const res = await proxy(event('/docs/My%20Resume.pdf'));
      assert.equal(res.statusCode, 200);
      assert.equal(decode(res), 'pdf');
      const utf8 = await proxy(event('/docs/caf%C3%A9.txt'));
      assert.equal(utf8.statusCode, 200);
    });

    it('rejects dot segments, encoded slashes and malformed escapes with a 400 (never reads S3)', async () => {
      const reads: GetInput[] = [];
      const proxy = loadHandler(generate({ spaFallback: true }), PATH_OBJECTS, reads);
      for (const bad of ['/a/../index.html', '/%2e%2e/index.html', '/..%2findex.html', '/a%2Fb.js', '/a%5Cb.js', '/%E0%A4%A.js', '/a%00.js']) {
        const res = await proxy(event(bad));
        assert.equal(res.statusCode, 400, `${bad} → ${res.statusCode}`);
      }
      assert.equal(reads.length, 0);
    });

    it('strips the basePath before the lookup (and leaves a path outside it alone)', async () => {
      const reads: GetInput[] = [];
      const proxy = loadHandler(generate({ spaFallback: false, stripPrefix: '/app' }), PATH_OBJECTS, reads);
      const res = await proxy(event('/app/robots.txt'));
      assert.equal(res.statusCode, 200);
      assert.equal(reads[0]?.Key, `${PREFIX}/robots.txt`);
      await proxy(event('/application/robots.txt'));
      assert.equal(reads[1]?.Key, `${PREFIX}/application/robots.txt`);
    });

    it('gzips a compressible file when the client accepts it, and says so', async () => {
      const proxy = loadHandler(generate({ spaFallback: false }), PATH_OBJECTS);
      const res = await proxy(event('/assets/big-abc.js', { 'accept-encoding': 'gzip, deflate, br' }));
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-encoding'], 'gzip');
      assert.equal(res.headers.vary, 'accept-encoding');
      assert.equal(res.isBase64Encoded, true);
      const raw = zlib.gunzipSync(Buffer.from(res.body, 'base64')).toString('utf8');
      assert.equal(raw, BIG_JS);
      assert.ok(Buffer.from(res.body, 'base64').length < BIG_JS.length / 4);
    });

    it('serves the file uncompressed without gzip in Accept-Encoding, and never gzips a binary type', async () => {
      const proxy = loadHandler(generate({ spaFallback: false }), PATH_OBJECTS);
      const plain = await proxy(event('/assets/big-abc.js'));
      assert.equal(plain.headers['content-encoding'], undefined);
      assert.equal(plain.headers.vary, 'accept-encoding');
      assert.equal(decode(plain), BIG_JS);
      const font = await proxy(event('/fonts/a.woff2', { 'accept-encoding': 'gzip' }));
      assert.equal(font.headers['content-encoding'], undefined);
    });

    it('returns the validators and answers a matching If-None-Match with a body-less 304', async () => {
      const reads: GetInput[] = [];
      const proxy = loadHandler(generate({ spaFallback: false }), PATH_OBJECTS, reads);
      const first = await proxy(event('/fonts/a.woff2'));
      assert.equal(first.headers.etag, '"font-etag"');
      const again = await proxy(event('/fonts/a.woff2', { 'if-none-match': '"font-etag"' }));
      assert.equal(again.statusCode, 304);
      assert.equal(again.body, '');
      assert.equal(again.headers.etag, '"font-etag"');
      assert.equal(reads[1]?.IfNoneMatch, '"font-etag"');
      // A gzipped representation carries a weak validator; it revalidates the same object.
      const gz = await proxy(event('/assets/big-abc.js', { 'accept-encoding': 'gzip' }));
      assert.equal(gz.headers.etag, 'W/"big-etag"');
      assert.equal(gz.headers['last-modified'], 'Fri, 02 Jan 2026 03:04:05 GMT');
      const gz304 = await proxy(event('/assets/big-abc.js', { 'accept-encoding': 'gzip', 'if-none-match': 'W/"big-etag"' }));
      assert.equal(gz304.statusCode, 304);
    });

    it('reads the app error page from S3 once per Lambda instance', async () => {
      const reads: GetInput[] = [];
      const proxy = loadHandler(generate(RULES), PATH_OBJECTS, reads);
      await proxy(event('/assets/gone-1.css'));
      await proxy(event('/assets/gone-2.css'));
      const pageReads = reads.filter((r) => r.Key === `${PREFIX}/404.html`);
      assert.equal(pageReads.length, 1);
    });

    it('collapses a spliced redirect target that would leave the site (no protocol-relative Location)', async () => {
      const proxy = loadHandler(generate({ redirects: [{ source: '/old/*', destination: '/*', statusCode: 301 }] }), PATH_OBJECTS);
      for (const [uri, location] of [
        ['/old//evil.example', '/evil.example'],
        ['/old/%5C%5Cevil.example', '/%5C%5Cevil.example'],
        ['/old/ok/page', '/ok/page'],
      ]) {
        const res = await proxy(event(uri));
        assert.equal(res.statusCode, 301);
        assert.equal(res.headers.location, location, uri);
      }
      const raw = await proxy(event('/old/\\\\evil.example'));
      assert.equal(raw.headers.location, '/evil.example');
    });
  });
}

for (const [label, generate, event] of variants) {
  describe(`${label} asset proxy — baseline security headers`, () => {
    it('every response carries them (a file, a redirect, a 404); an app header rule of the same name wins', async () => {
      const proxy = loadHandler(
        generate({
          spaFallback: false,
          redirects: [{ source: '/old', destination: '/new', statusCode: 301 }],
          headers: [{ pattern: '/assets/*', headers: { 'X-Frame-Options': 'DENY' } }],
        }),
        PATH_OBJECTS,
      );
      for (const uri of ['/robots.txt', '/old', '/missing.css']) {
        const res = await proxy(event(uri));
        assert.equal(res.headers['strict-transport-security'], 'max-age=31536000', uri);
        assert.equal(res.headers['x-content-type-options'], 'nosniff', uri);
        assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN', uri);
        assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin', uri);
      }
      assert.equal((await proxy(event('/assets/big-abc.js'))).headers['x-frame-options'], 'DENY');
    });
  });
}
