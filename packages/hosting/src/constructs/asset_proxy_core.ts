// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The serving logic shared by the asset-proxy Lambdas of the ALB door
 * (`alb_asset_proxy.ts`) and the API Gateway doors (`apigw_asset_proxy.ts`);
 * each wraps it in its own event / response envelope.
 *
 * `blocksServe(uri)` answers one request path the way the CloudFront door
 * does, with the app's rules matched by the edge router's own code (see
 * `proxy_rules.ts`):
 *
 *   1. the first matching redirect → its status and `Location` (no origin read);
 *   2. strip the basePath / assetPrefix, resolve the directory index or the
 *      single-page-app fallback, read `builds/<buildId>/<path>` from the
 *      private bucket, and serve it with its Content-Type and its stored
 *      Cache-Control (a default only when it has none);
 *   3. a missing file → 404, with the app's not-found page when it has one;
 *      any other S3 failure → 500, with the app's server-error page;
 *   4. every matching header rule is applied to a successful (non-error,
 *      non-redirect) response, as a CloudFront viewer-response function is.
 *
 * Emitted as INLINE Lambda code: it uses only `@aws-sdk/client-s3`, which the
 * Node.js Lambda runtime provides.
 *
 * @internal Framework-only.
 */
import { type ProxyRules, proxyRulesJs } from './proxy_rules.js';

/** Options of the asset-proxy generators. */
export type AssetProxyOptions = ProxyRules & {
  /** basePath / assetPrefix to strip from the URL before the lookup. @default '' */
  stripPrefix?: string;
  /** Serve `index.html` for an unknown extensionless path (single-page app) vs a real 404. */
  spaFallback?: boolean;
  /**
   * The app's error pages, as object keys under the build prefix (e.g.
   * `404.html`): `notFound` is served (status 404) for a missing file,
   * `serverError` (status 500) when S3 fails.
   */
  errorPages?: { notFound?: string; serverError?: string };
};

/**
 * The shared serving source (see the module doc): defines `blocksServe(uri)`,
 * which resolves to `{ statusCode, headers, body, isBase64Encoded }`.
 *
 * @param opts the prefix to strip, the SPA fallback, and the app's rules and error pages.
 * @returns the source, to inline ahead of an envelope handler.
 */
export const assetProxyCoreJs = (opts: AssetProxyOptions): string => {
  const pageKey = (page: string | undefined): string => JSON.stringify((page ?? '').replace(/^\/+/, ''));
  return `const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client({});
const BUCKET = process.env.ASSET_BUCKET;
const KEY_PREFIX = process.env.ASSET_KEY_PREFIX || '';
const STRIP_PREFIX = ${JSON.stringify(opts.stripPrefix ?? '')};
const SPA_FALLBACK = ${opts.spaFallback ? 'true' : 'false'};
const NOT_FOUND_PAGE = ${pageKey(opts.errorPages?.notFound)};
const SERVER_ERROR_PAGE = ${pageKey(opts.errorPages?.serverError)};

${proxyRulesJs(opts)}

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript',
  css: 'text/css', json: 'application/json', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  ico: 'image/x-icon', txt: 'text/plain; charset=utf-8', xml: 'application/xml',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  map: 'application/json', webmanifest: 'application/manifest+json',
};

function contentTypeFor(key) {
  const dot = key.lastIndexOf('.');
  const ext = dot === -1 ? '' : key.substring(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

// The object's own Cache-Control (set per file at upload); a default only when
// it has none: HTML always revalidates, anything else revalidates too (an
// unhashed file must not be pinned for a year).
function cacheControlFor(stored, isHtml) {
  if (stored) return stored;
  return isHtml ? 'no-cache, no-store, must-revalidate' : 'public, max-age=0, must-revalidate';
}

async function readStream(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function keyFor(uri) {
  return (KEY_PREFIX ? KEY_PREFIX.replace(/\\/+$/, '') + '/' : '') + uri.replace(/^\\/+/, '');
}

async function fetchKey(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return { buf: await readStream(res.Body), contentType: res.ContentType || contentTypeFor(key), cacheControl: res.CacheControl };
}

// A missing key: NoSuchKey with list access, AccessDenied without (S3 hides
// absence) — the CloudFront door maps the latter to a 404 too.
function isMiss(err) {
  const name = err && err.name;
  const status = err && err.$metadata && err.$metadata.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || name === 'AccessDenied' || status === 404 || status === 403;
}

async function errorResponse(statusCode) {
  const page = statusCode === 404 ? NOT_FOUND_PAGE : SERVER_ERROR_PAGE;
  if (page) {
    try {
      const { buf } = await fetchKey(keyFor(page));
      return {
        statusCode,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, no-store, must-revalidate' },
        body: buf.toString('base64'),
        isBase64Encoded: true,
      };
    } catch (e) {
      // The page itself is unreadable: fall back to the plain answer.
    }
  }
  return {
    statusCode,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: statusCode === 404 ? 'Not Found' : 'Internal Server Error',
    isBase64Encoded: false,
  };
}

async function blocksServe(requestUri) {
  const redirect = blocksRedirect(requestUri);
  if (redirect) {
    return { statusCode: redirect.statusCode, headers: { location: redirect.location }, body: '', isBase64Encoded: false };
  }
  const key = keyFor(resolveIndex(stripBasePath(requestUri, STRIP_PREFIX), SPA_FALLBACK));
  let found;
  try {
    found = await fetchKey(key);
  } catch (err) {
    // A miss is a 404. Extensionless SPA paths already resolved to index.html
    // above, so a missing file here (/missing.js, /.env) is really missing.
    return errorResponse(isMiss(err) ? 404 : 500);
  }
  const headers = {
    'content-type': found.contentType,
    'cache-control': cacheControlFor(found.cacheControl, found.contentType.indexOf('text/html') === 0),
  };
  const rule = blocksHeaders(requestUri);
  for (const name in rule) headers[name] = rule[name];
  return { statusCode: 200, headers, body: found.buf.toString('base64'), isBase64Encoded: true };
}
`;
};
