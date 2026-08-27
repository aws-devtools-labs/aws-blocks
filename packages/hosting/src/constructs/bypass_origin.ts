// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Construct } from 'constructs';
import { Duration } from 'aws-cdk-lib';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import {
  HttpLambdaIntegration,
  HttpUrlIntegration,
} from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
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
 * WAF/security-headers/compression.
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
    const assetFn = new LambdaFunction(this, 'AssetProxy', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: {
        BUCKET: bucket.bucketName,
        KEY_PREFIX: `builds/${buildId}`,
        // Static/SPA with no server: a miss serves index.html so the client
        // router can deep-link. With a server, a miss is a real 404 (the
        // server owns routing).
        SPA_FALLBACK: !serverFn && spaFallback ? '1' : '',
      },
      code: Code.fromInline(ASSET_PROXY_SOURCE),
    });
    bucket.grantRead(assetFn);
    const assetIntegration = new HttpLambdaIntegration('AssetInt', assetFn);

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

    // ---- static prefixes → asset proxy ----
    const staticPrefixes = new Set<string>();
    const firstSeg = (p: string) => p.replace(/^\//, '').split('/')[0];
    for (const glob of manifest.staticAssets.immutablePaths ?? []) {
      const seg = firstSeg(glob);
      if (seg && seg !== '*' && seg !== '(.*)') staticPrefixes.add(seg);
    }
    for (const route of manifest.routes) {
      if (route.target !== 'static') continue;
      const seg = firstSeg(route.pattern);
      if (seg && seg !== '*' && seg !== '(.*)') staticPrefixes.add(seg);
    }
    for (const prefix of staticPrefixes) {
      // Directory prefix (`_next`, `.blocks-sandbox`) → greedy; exact root file
      // (`favicon.ico`) → itself.
      const isDir = !prefix.includes('.') || prefix.startsWith('.');
      this.api.addRoutes({
        path: isDir ? `/${prefix}/{proxy+}` : `/${prefix}`,
        methods: [HttpMethod.GET],
        integration: assetIntegration,
      });
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
exports.handler = async (event) => {
  const raw = (event.rawPath || event.path || '/').replace(/^\\/+/, '').replace(/\\/+$/, '');
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
};
`;
