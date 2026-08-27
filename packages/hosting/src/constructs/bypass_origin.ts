// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Construct } from 'constructs';
import { Duration, Stack } from 'aws-cdk-lib';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import {
  HttpLambdaIntegration,
  HttpUrlIntegration,
} from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Fn } from 'aws-cdk-lib';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import type { DeployManifest } from '../manifest/types.js';

/**
 * Props for {@link BypassOriginConstruct}.
 */
export type BypassOriginConstructProps = {
  /** The deploy manifest (routes + static/compute targets). Framework-agnostic. */
  manifest: DeployManifest;
  /** Build id — assets live under `builds/<buildId>/` in the bucket. */
  buildId: string;
  /** The private assets bucket (read by the asset-proxy Lambda, not public). */
  bucket: IBucket;
  /** Compute functions by manifest name (SSR server, etc.). */
  computeFunctions: Map<string, IFunction>;
  /**
   * The SSR/server compute name that owns the catch-all (`'default'` or
   * `'server'`), or undefined for a static/SPA site (no compute).
   */
  serverComputeName?: string;
  /**
   * Backend API Gateway URL (`https://…/aws-blocks/api`) to proxy `/aws-blocks/*`
   * + `/auth/*` through this SAME origin — so the frontend calls the API
   * same-origin (`SameSite=Lax` cookies flow, no CORS). Omit for a site with no
   * backend.
   */
  backendApiUrl?: string;
};

// ---- Construct ----

/**
 * **Preview `bypassCdn` — HTTP API v2 single origin (no CloudFront).**
 *
 * Serves an entire hosting deploy — static assets, SSR compute, and the Blocks
 * backend API — from ONE **HTTP API v2** origin at the **domain root** (the
 * `$default` stage has no `/stage` path), so the framework's root-absolute URLs
 * (`/_next/*`, `/`, `/favicon.ico`) resolve correctly and the app is
 * same-origin (cookies + no CORS). No CloudFront distribution is created (fast,
 * throwaway preview deploys).
 *
 * Framework-agnostic: routing is derived from the {@link DeployManifest}:
 * - **static prefixes** (`_next`, `_astro`, `_nuxt`, `_app`, exact root files)
 *   from `staticAssets.immutablePaths` + `routes[]` → a small asset-proxy
 *   Lambda that streams objects out of the private bucket (`builds/<buildId>/…`).
 * - **`/aws-blocks/{proxy+}` + `/auth/{proxy+}`** → HTTP proxy to the backend
 *   API Gateway (same-origin — this is what makes cookie auth work in bypass).
 * - **`$default` (catch-all)** → the SSR server Lambda (built for HTTP API v2,
 *   buffered — HTTP API has no response streaming). For a static/SPA site (no
 *   compute) the catch-all falls back to `index.html` from S3.
 *
 * **Trade-offs (documented, preview-only):** SSR responses are **buffered**
 * (no progressive/streaming render — HTTP API can't stream; production keeps
 * streaming via CloudFront + REST-API STREAM), no edge cache, no
 * WAF/security-headers/compression, and **image optimization is skipped** —
 * the framework image endpoints (`_ipx`, `_next/image`, `_image`) degrade to
 * the original source image (served unoptimized by the asset proxy).
 */
export class BypassOriginConstruct extends Construct {
  /** The single public origin URL (domain root — no stage path). */
  readonly url: string;
  readonly api: HttpApi;

  constructor(scope: Construct, id: string, props: BypassOriginConstructProps) {
    super(scope, id);
    const { manifest, buildId, bucket, computeFunctions, serverComputeName, backendApiUrl } = props;

    const spaFallback = manifest.staticAssets.spaFallback ?? true;
    const serverFn = serverComputeName ? computeFunctions.get(serverComputeName) : undefined;

    // ---- Asset-proxy Lambda: streams objects from the private bucket ----
    // HTTP API v2 can't use the REST S3 AwsIntegration, so a tiny Lambda reads
    // `builds/<buildId>/<path>` and returns it. Keeps the bucket private (no
    // public-read), which is portable across accounts with S3 BPA on.
    // URL prefix the framework prepends to asset URLs — `assetPrefix`
    // (Next.js) or `basePath` (Next/Nuxt `app.baseURL`). The bytes live in S3
    // WITHOUT it (`builds/<id>/_next/*`, not `.../cdn-assets/_next/*`), but the
    // browser requests them WITH it (`/cdn-assets/_next/*`, `/myapp/_nuxt/*`).
    // So we route the prefixed URLs to the asset proxy and strip the prefix
    // before the S3 lookup. Leading slash, no trailing slash; '' when neither.
    const assetUrlPrefix = (manifest.assetPrefix ?? manifest.basePath ?? '')
      .replace(/\/+$/, '');

    const assetFn = new LambdaFunction(this, 'AssetProxy', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: {
        BUCKET: bucket.bucketName,
        KEY_PREFIX: `builds/${buildId}`,
        // Stripped from the request path before the S3 lookup (see above).
        STRIP_PREFIX: assetUrlPrefix,
        // Static/SPA with no server: a miss serves index.html so the client
        // router can deep-link. With a server, a miss is a real 404 (the
        // server owns routing).
        SPA_FALLBACK: !serverFn && spaFallback ? '1' : '',
      },
      code: Code.fromInline(ASSET_PROXY_SOURCE),
    });
    bucket.grantRead(assetFn);
    // `scopePermissionToRoute: false` → the integration adds ONE api-scoped
    // invoke-permission instead of one per route. The asset proxy backs every
    // static route (bare + greedy + GET/HEAD/OPTIONS, per prefix, plus the image
    // endpoints below); per-route permissions would multiply into the 20 KB
    // Lambda resource-policy limit. NOTE: CDK's api-scoped grant is
    // `execute-api:.../*/*/*` (3 segments), which matches normal routes but NOT
    // the `$default` catch-all's 2-segment invoke ARN — so a no-server (SPA /
    // static) site, whose `$default` IS this integration, would 500 on `/`. The
    // explicit `*/*` grant below covers `$default` too. Both are constant (2
    // statements total), so route count still never bounds the policy size.
    const assetIntegration = new HttpLambdaIntegration('AssetInt', assetFn, {
      scopePermissionToRoute: false,
    });

    // ---- HTTP API (root path via the auto `$default` stage) ----
    // Default route → SSR Lambda (buffered, payload v2 matches the
    // `aws-apigw-v2` converter the adapter builds under bypassCdn). No server
    // → default to the asset proxy (which serves index.html on miss for SPA).
    const defaultIntegration = serverFn
      ? new HttpLambdaIntegration('SsrInt', serverFn)
      : assetIntegration;
    this.api = new HttpApi(this, 'BypassApi', {
      apiName: `bypass-${buildId}`.substring(0, 128),
      defaultIntegration,
    });

    // One broad invoke-permission covering EVERY route of this API, including
    // the `$default` catch-all (which CDK's `scopePermissionToRoute:false` grant
    // misses — see the assetIntegration note). `*/*` = any stage / any
    // method+path (IAM `*` spans `/`), so it authorizes both `$default` and the
    // named asset routes with a single statement.
    assetFn.addPermission('BypassApiInvoke', {
      principal: new ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: Stack.of(this).formatArn({
        service: 'execute-api',
        resource: this.api.apiId,
        resourceName: '*/*',
      }),
    });

    // Static assets answer the read/preflight methods, not just GET. The
    // browser's module loader fetches `rel=modulepreload`/`rel=prefetch`
    // crossorigin chunks with a HEAD (and, cross-origin, an OPTIONS preflight);
    // a GET-only route misses those, so they leak to the SSR `$default`
    // integration, which 500s on an asset path — failing the module load even
    // though the GET body is fine. GET/HEAD/OPTIONS share one method-wildcarded
    // Lambda invoke-permission (`execute-api:.../*/*<path>`), so this adds route
    // keys but no new resource-policy statements. Write methods still fall
    // through to SSR (so App-router server-action POSTs to a prerendered path
    // keep reaching the server).
    const STATIC_METHODS = [HttpMethod.GET, HttpMethod.HEAD, HttpMethod.OPTIONS];

    const firstSeg = (p: string) => p.replace(/^\//, '').split('/')[0];
    const prefixBase = (seg: string) =>
      // Framework asset dirs live under the app's basePath/assetPrefix in the
      // browser (`/myapp/_nuxt/*`), so mount them there. `.blocks-sandbox` is a
      // Blocks-internal path the client always fetches at the domain root
      // (`/.blocks-sandbox/config.json`), so it stays unprefixed.
      seg.startsWith('.blocks-sandbox') ? '' : assetUrlPrefix;

    // ---- static prefixes → asset proxy (greedy, one route per top segment) ----
    // Collapse every static route + immutable-asset glob to its FIRST path
    // segment and mount ONE greedy `{proxy+}` route per segment. Collapsing is
    // load-bearing: an app can have many prerendered pages under one prefix
    // (`/products/p1`, `/products/p2`, … or a stress app's `/stress/1..N`);
    // one route per page would add one Lambda invoke-permission each and blow
    // the asset proxy's resource-policy size limit (20 KB). The asset proxy's
    // directory-index resolution serves each nested page (`/products/p1` →
    // products/p1/index.html or products/p1.html), so greedy is correct for
    // prerendered subtrees. (A genuinely DYNAMIC child under a prerendered
    // prefix would 404 here rather than reach SSR — a rare, documented edge.)
    const staticPrefixes = new Set<string>();
    // Prefixes whose BARE path (`/about`) is itself a prerendered page — only
    // these get a bare route (see the route loop). A prefix that exists ONLY
    // because of nested prerendered pages (`/products/p1` → prefix `products`,
    // with a DYNAMIC `/products` index) must NOT get a bare route, or the bare
    // path would be captured by the asset proxy (→ 404) instead of reaching SSR.
    // The signal: a static route whose whole pattern is that one segment —
    // `/about` or `/about/*` (norm === seg), NOT `/products/p1/*`.
    const barePrefixes = new Set<string>();
    for (const glob of manifest.staticAssets.immutablePaths ?? []) {
      const seg = firstSeg(glob);
      if (seg && seg !== '*' && seg !== '(.*)') staticPrefixes.add(seg);
    }
    for (const route of manifest.routes) {
      if (route.target !== 'static') continue;
      const seg = firstSeg(route.pattern);
      if (seg && seg !== '*' && seg !== '(.*)') {
        staticPrefixes.add(seg);
        const norm = route.pattern.replace(/^\//, '').replace(/\/\*$/, '').replace(/\/$/, '');
        if (norm === seg) barePrefixes.add(seg); // pattern is just `/<seg>` (+ optional `/*`)
      }
    }
    // Image-optimization endpoints. Under bypass, `skipImageOptimization` is
    // always on (no image Lambda), so these degrade to the SOURCE image: the
    // asset proxy recovers the original object key and serves it unoptimized
    // (see ASSET_PROXY_SOURCE). Route them here so they reach the proxy instead
    // of leaking to the SSR `$default` (which 403s an `_ipx` request with no
    // sharp/allowlist). `_next/image` needs no entry — it's already covered by
    // the `_next` immutable-asset prefix; the proxy reads its `?url=` query.
    staticPrefixes.add('_ipx'); // Nuxt / @nuxt/image (ipx)
    staticPrefixes.add('_image'); // Astro
    for (const prefix of staticPrefixes) {
      // Directory prefix (`_next`, `products`, `.blocks-sandbox`) → greedy;
      // exact root file (`favicon.ico`) → itself.
      const isDir = !prefix.includes('.') || prefix.startsWith('.');
      const base = prefixBase(prefix);
      if (isDir) {
        // Bare path (`/about`): HTTP API `{proxy+}` matches `/about/x` but NOT
        // `/about` itself, so a prerendered bare page (served from
        // about/index.html via directory-index) needs its own route — otherwise
        // it falls to the SSR catch-all (500 on a static-only app, or a wrong
        // render). Add it ONLY when the bare path is actually prerendered
        // (`barePrefixes`); a prefix that exists only via nested pages
        // (`/products/p1`) with a DYNAMIC `/products` index must let the bare
        // path reach SSR instead of being captured here (→ 404). The greedy
        // subtree is always mounted — its directory-index serves the nested
        // prerendered pages. Two routes/prefix (not per page) keeps the asset
        // proxy's invoke-permission policy small.
        if (barePrefixes.has(prefix)) {
          this.api.addRoutes({
            path: `${base}/${prefix}`,
            methods: STATIC_METHODS,
            integration: assetIntegration,
          });
        }
        this.api.addRoutes({
          path: `${base}/${prefix}/{proxy+}`,
          methods: STATIC_METHODS,
          integration: assetIntegration,
        });
      } else {
        this.api.addRoutes({
          path: `${base}/${prefix}`,
          methods: STATIC_METHODS,
          integration: assetIntegration,
        });
      }
    }

    // ---- backend API proxy (/aws-blocks/* + /auth/*) → same origin ----
    if (backendApiUrl) {
      // backendApiUrl e.g. https://host/prod/aws-blocks/api → stage root
      // https://host/prod, re-mounting /aws-blocks and /auth under this origin.
      const stageRoot = Fn.select(0, Fn.split('/aws-blocks', backendApiUrl));
      for (const prefix of ['aws-blocks', 'auth']) {
        this.api.addRoutes({
          path: `/${prefix}/{proxy+}`,
          methods: [HttpMethod.ANY],
          // `{proxy}` is substituted from the greedy route param.
          integration: new HttpUrlIntegration(
            `Backend-${prefix}`,
            `${stageRoot}/${prefix}/{proxy}`,
            { method: HttpMethod.ANY },
          ),
        });
      }
    }

    // HTTP API `$default` stage serves at the API endpoint ROOT (no /stage).
    this.url = this.api.apiEndpoint;
  }
}

/**
 * Inline source for the asset-proxy Lambda. Reads `KEY_PREFIX/<rawPath>` from
 * BUCKET and returns it (base64 for binary safety). On a miss: `index.html`
 * when SPA_FALLBACK is set (client-router deep-link), else 404. Uses the AWS
 * SDK v3 bundled in the Lambda Node runtime (no extra deps).
 */
const ASSET_PROXY_SOURCE = `
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client({});
const BUCKET = process.env.BUCKET;
const PREFIX = process.env.KEY_PREFIX;
const SPA = process.env.SPA_FALLBACK === '1';
const STRIP = (process.env.STRIP_PREFIX || '').replace(/^\\/+/, '').replace(/\\/+$/, '');
async function get(key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const bytes = await r.Body.transformToByteArray();
  return { body: Buffer.from(bytes), contentType: r.ContentType, cacheControl: r.CacheControl };
}
function ok(o, cacheOverride) {
  return {
    statusCode: 200,
    headers: {
      'content-type': o.contentType || 'application/octet-stream',
      'cache-control': cacheOverride || o.cacheControl || 'public, max-age=31536000, immutable',
    },
    body: o.body.toString('base64'),
    isBase64Encoded: true,
  };
}
function redirect(location) {
  // A remote image source (the app asked its image optimizer to fetch+resize a
  // remote URL). The proxy does NOT fetch it — a Lambda that fetches arbitrary
  // URLs is an open SSRF proxy (instance metadata, internal endpoints). Instead
  // 302 so the BROWSER loads the origin directly (unoptimized) — the same bytes
  // the app's <img> would get from the source, with no server-side fetch.
  return { statusCode: 302, headers: { location, 'cache-control': 'no-cache' }, body: '' };
}
exports.handler = async (event) => {
  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || event.httpMethod || 'GET';
  // OPTIONS: a CORS preflight (the browser's crossorigin module loader may send
  // one). Answer it directly — never resolve it to a file body.
  if (method === 'OPTIONS') {
    const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '*';
    return { statusCode: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-allow-headers': '*', 'access-control-max-age': '600', vary: 'Origin' }, body: '' };
  }
  const res = await serve(event);
  // HEAD: same status + headers as GET, but no body.
  if (method === 'HEAD') { res.body = ''; res.isBase64Encoded = false; }
  return res;
};
async function serve(event) {
  let raw = (event.rawPath || event.path || '/').replace(/^\\/+/, '').replace(/\\/+$/, '');
  // Strip the framework's basePath/assetPrefix so the key matches the bytes,
  // which are stored WITHOUT it (e.g. '/myapp/_nuxt/x.js' → '_nuxt/x.js').
  if (STRIP && (raw === STRIP || raw.startsWith(STRIP + '/'))) {
    raw = raw.slice(STRIP.length).replace(/^\\/+/, '');
  }
  // Image optimization is skipped under bypass (no image Lambda) — degrade each
  // framework's image endpoint to the ORIGINAL source object so the <img> still
  // renders (unoptimized). Recover the source key from the request shape:
  //   ipx (Nuxt):        '_ipx/<modifiers>/<src>'        → '<src>'
  //   Next.js:           '_next/image?url=<src>&w=&q='   → '<src>'
  //   Astro:             '_image?href=<src>&w=&f='       → '<src>'
  // The source may carry the app's basePath/assetPrefix (Next encodes it into
  // ?url=); strip it the same way as the request path. A REMOTE source
  // (http(s)://…) isn't in the bucket — 302 the browser to the origin instead.
  if (raw.startsWith('_ipx/')) {
    const rest = raw.slice('_ipx/'.length);
    const slash = rest.indexOf('/');
    const src = slash >= 0 ? rest.slice(slash + 1) : rest; // drop the modifiers segment
    // ipx inlines a remote source ('_ipx/<mods>/https://host/…'); APIGW can
    // collapse the '//' in rawPath, so re-normalize before the remote check.
    const remote = src.replace(/^(https?):\\/+/i, '$1://');
    if (/^https?:\\/\\//i.test(remote)) return redirect(remote);
    raw = src;
  } else if (raw === '_next/image' || raw === '_image') {
    const q = event.queryStringParameters || {};
    const src = q.url || q.href || '';
    if (/^https?:\\/\\//i.test(src)) return redirect(src); // remote — browser loads it
    raw = src.replace(/^\\/+/, '').replace(/\\/+$/, '');
    if (STRIP && (raw === STRIP || raw.startsWith(STRIP + '/'))) {
      raw = raw.slice(STRIP.length).replace(/^\\/+/, '');
    }
  }
  // Candidate keys, in order: exact file, then (for extensionless paths) the
  // static multi-page resolutions '<path>/index.html' and '<path>.html'. This
  // is directory-index resolution — a static multi-page site (e.g. Astro
  // \`output: 'static'\`) serves /about from about/index.html or about.html.
  const hasExt = /\\.[a-zA-Z0-9]+$/.test(raw);
  const candidates = !raw
    ? ['index.html']
    : hasExt
      ? [raw]
      : [raw, raw + '/index.html', raw + '.html'];
  for (const c of candidates) {
    try { return ok(await get(PREFIX + '/' + c)); } catch (_) { /* next */ }
  }
  // SPA sites: an unknown route serves index.html (client router owns routing).
  if (SPA) {
    try { return ok(await get(PREFIX + '/index.html'), 'no-cache'); } catch (_) {}
  }
  // Static multi-page: serve the build's 404 page (real 404 status) if present.
  try {
    const nf = await get(PREFIX + '/404.html');
    return { statusCode: 404, headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' }, body: nf.body.toString('base64'), isBase64Encoded: true };
  } catch (_) {}
  return { statusCode: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found' };
}
`;
