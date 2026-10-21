// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The serving logic shared by the asset-proxy Lambdas of the ALB door
 * (`alb_asset_proxy.ts`) and the API Gateway doors (`apigw_asset_proxy.ts`);
 * each wraps it in its own event / response envelope.
 *
 * `blocksServe(uri, headers)` answers one request path the way the CloudFront
 * door does, with the app's rules matched by the edge router's own code (see
 * `proxy_rules.ts`):
 *
 *   1. the first matching redirect → its status and `Location` (no origin read);
 *   2. percent-decode the path (as S3 does behind the CloudFront door; a dot
 *      segment, an encoded slash or backslash, a control character or a
 *      malformed escape is a 400), strip the basePath / assetPrefix, resolve
 *      the directory index or the single-page-app fallback, read
 *      `builds/<buildId>/<path>` from the private bucket, and serve it with
 *      its Content-Type, its stored Cache-Control (a default only when it has
 *      none) and its validators (`ETag`, `Last-Modified`);
 *   3. a conditional request (`If-None-Match`, `If-Modified-Since`) the object
 *      still matches → a body-less 304;
 *   4. a compressible file (text, JSON, JavaScript, SVG, …) of 1 KiB or more
 *      is gzipped when the client accepts it (`Vary: accept-encoding`; the
 *      validator becomes weak), so it travels — and fits the door's response
 *      limit — compressed, as on CloudFront;
 *   5. a missing file → 404, with the app's not-found page when it has one;
 *      any other S3 failure → 500, with the app's server-error page (each page
 *      is read once per Lambda instance — the prefix is fixed per build);
 *   6. every matching header rule is applied to a successful (non-error,
 *      non-redirect) response, as a CloudFront viewer-response function is.
 *
 * It reads only the current build's prefix: a tab opened before a deploy that
 * lazily loads a chunk of the previous build gets a 404 (the CloudFront door's
 * skew protection does not apply here).
 *
 * Emitted as INLINE Lambda code: it uses only `@aws-sdk/client-s3` and
 * `node:zlib`, which the Node.js Lambda runtime provides.
 *
 * @internal Framework-only.
 */
import { type ProxyRules, proxyRulesJs } from './proxy_rules.js';

/**
 * Content types the asset proxies gzip for a client that accepts it (and the
 * synth size check measures compressed): text, JSON, JavaScript, XML, SVG,
 * web manifests.
 */
export const COMPRESSIBLE_TYPE_RE = /^(text\/|image\/svg\+xml|application\/(json|javascript|xml|manifest\+json|[\w.+-]*\+(json|xml))\b)/i;

/** Files smaller than this are served uncompressed (gzip would not pay for its header). */
export const MIN_COMPRESS_BYTES = 1024;

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
 * The shared serving source (see the module doc): defines
 * `blocksServe(uri, headers)` (the request path and headers, any name case),
 * which resolves to `{ statusCode, headers, body, isBase64Encoded }`.
 *
 * @param opts the prefix to strip, the SPA fallback, and the app's rules and error pages.
 * @returns the source, to inline ahead of an envelope handler.
 */
export const assetProxyCoreJs = (opts: AssetProxyOptions): string => {
  const pageKey = (page: string | undefined): string => JSON.stringify((page ?? '').replace(/^\/+/, ''));
  return `const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const zlib = require('node:zlib');
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
// Gzipped when the client accepts it (as CloudFront compresses them).
const COMPRESSIBLE = ${COMPRESSIBLE_TYPE_RE.toString()};
const MIN_COMPRESS_BYTES = ${MIN_COMPRESS_BYTES};

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

// Request header names in any case (a REST API keeps the client's).
function lowerHeaders(h) {
  const out = {};
  for (const k in h || {}) { const v = h[k]; out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v); }
  return out;
}

// The S3 key path for a request path: percent-decoded (S3 decodes the path
// behind the CloudFront door too), or null for a path that must not reach S3 —
// an encoded slash or backslash, a malformed escape, a control character or a
// backslash, or a '.' / '..' segment.
function decodePath(uri) {
  if (/%2f|%5c/i.test(uri)) return null;
  let decoded;
  try { decoded = decodeURIComponent(uri); } catch (e) { return null; }
  if (/[\\u0000-\\u001f\\u007f\\\\]/.test(decoded)) return null;
  const segs = decoded.split('/');
  for (let i = 0; i < segs.length; i++) { if (segs[i] === '.' || segs[i] === '..') return null; }
  return decoded;
}

async function fetchKey(key, conditions) {
  const input = { Bucket: BUCKET, Key: key };
  if (conditions && conditions.ifNoneMatch) input.IfNoneMatch = conditions.ifNoneMatch;
  if (conditions && conditions.ifModifiedSince) input.IfModifiedSince = conditions.ifModifiedSince;
  const res = await s3.send(new GetObjectCommand(input));
  return {
    buf: await readStream(res.Body),
    contentType: res.ContentType || contentTypeFor(key),
    cacheControl: res.CacheControl,
    etag: res.ETag,
    lastModified: res.LastModified ? new Date(res.LastModified).toUTCString() : undefined,
  };
}

// A missing key: NoSuchKey with list access, AccessDenied without (S3 hides
// absence) — the CloudFront door maps the latter to a 404 too.
function isMiss(err) {
  const name = err && err.name;
  const status = err && err.$metadata && err.$metadata.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || name === 'AccessDenied' || status === 404 || status === 403;
}

function isNotModified(err) {
  return Boolean(err && ((err.$metadata && err.$metadata.httpStatusCode === 304) || err.name === 'NotModified'));
}

function plainResponse(statusCode, text) {
  return { statusCode, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: text, isBase64Encoded: false };
}

// The error pages, read once per Lambda instance (the prefix is fixed per build).
const ERROR_PAGES = {};
async function errorResponse(statusCode) {
  const page = statusCode === 404 ? NOT_FOUND_PAGE : SERVER_ERROR_PAGE;
  if (page) {
    try {
      if (!ERROR_PAGES[page]) ERROR_PAGES[page] = (await fetchKey(keyFor(page))).buf;
      return {
        statusCode,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, no-store, must-revalidate' },
        body: ERROR_PAGES[page].toString('base64'),
        isBase64Encoded: true,
      };
    } catch (e) {
      // The page itself is unreadable: fall back to the plain answer.
    }
  }
  return plainResponse(statusCode, statusCode === 404 ? 'Not Found' : 'Internal Server Error');
}

async function blocksServe(requestUri, requestHeaders) {
  const redirect = blocksRedirect(requestUri);
  if (redirect) {
    return { statusCode: redirect.statusCode, headers: { location: redirect.location }, body: '', isBase64Encoded: false };
  }
  const path = decodePath(requestUri);
  if (path === null) return plainResponse(400, 'Bad Request');
  const req = lowerHeaders(requestHeaders);
  const key = keyFor(resolveIndex(stripBasePath(path, STRIP_PREFIX), SPA_FALLBACK));
  const gzip = /\\bgzip\\b/i.test(req['accept-encoding'] || '');
  // A weak validator names the same object (a gzipped representation's).
  const ifNoneMatch = req['if-none-match'] ? req['if-none-match'].replace(/^W\\//, '') : undefined;
  const ifModifiedSince = req['if-modified-since'] ? new Date(req['if-modified-since']) : undefined;
  let found;
  try {
    found = await fetchKey(key, {
      ifNoneMatch,
      ifModifiedSince: ifModifiedSince && !isNaN(ifModifiedSince.getTime()) ? ifModifiedSince : undefined,
    });
  } catch (err) {
    if (isNotModified(err)) {
      const headers = {};
      if (req['if-none-match']) headers.etag = req['if-none-match'];
      return { statusCode: 304, headers, body: '', isBase64Encoded: false };
    }
    // A miss is a 404. Extensionless SPA paths already resolved to index.html
    // above, so a missing file here (/missing.js, /.env) is really missing.
    return errorResponse(isMiss(err) ? 404 : 500);
  }
  const headers = {
    'content-type': found.contentType,
    'cache-control': cacheControlFor(found.cacheControl, found.contentType.indexOf('text/html') === 0),
  };
  if (found.lastModified) headers['last-modified'] = found.lastModified;
  let body = found.buf;
  const compressible = COMPRESSIBLE.test(found.contentType);
  if (compressible) headers.vary = 'accept-encoding';
  if (compressible && gzip && body.length >= MIN_COMPRESS_BYTES) {
    body = zlib.gzipSync(body);
    headers['content-encoding'] = 'gzip';
    if (found.etag) headers.etag = 'W/' + found.etag.replace(/^W\\//, '');
  } else if (found.etag) {
    headers.etag = found.etag;
  }
  const rule = blocksHeaders(requestUri);
  for (const name in rule) headers[name] = rule[name];
  return { statusCode: 200, headers, body: body.toString('base64'), isBase64Encoded: true };
}
`;
};
