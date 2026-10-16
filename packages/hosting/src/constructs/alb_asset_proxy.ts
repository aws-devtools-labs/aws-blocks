/**
 * Static asset-proxy Lambda for the ALB front door.
 *
 * An Application Load Balancer (ALB) cannot use an S3 bucket as a target
 * directly (and the assets bucket is private — BLOCK_ALL, no public read). So
 * the ALB routes static paths to this tiny Lambda TARGET, which streams the
 * object out of `builds/<buildId>/<path>` in the private bucket. This is the
 * ALB analogue of CloudFront's S3+OAC origin.
 *
 * The handler speaks the ALB↔Lambda contract (NOT API Gateway): the event is
 * `{ path, httpMethod, headers, queryStringParameters, body, isBase64Encoded }`
 * and the response must be
 * `{ statusCode, statusDescription, headers, body, isBase64Encoded }`.
 *
 * Emitted as INLINE Lambda code (no bundle step): it uses only
 * `@aws-sdk/client-s3`, which is present in the Node.js Lambda runtime.
 *
 * Behaviour mirrors the CloudFront static branch:
 *   - strip a configured basePath prefix before the S3 lookup,
 *   - directory-index / SPA fallback for extensionless paths,
 *   - map to `builds/<buildId>/<path>` and return the bytes with the object's
 *     Content-Type; a miss is a 404 (or index.html under SPA fallback).
 */

/**
 * Build the inline handler source for the asset-proxy Lambda.
 *
 * @param opts.bucketEnv     env var name holding the bucket name (default `ASSET_BUCKET`)
 * @param opts.keyPrefixEnv  env var name holding the `builds/<id>` key prefix (default `ASSET_KEY_PREFIX`)
 * @param opts.stripPrefix   basePath/assetPrefix to strip from the URL before lookup (default '')
 * @param opts.spaFallback   serve `index.html` on a miss (SPA) vs a real 404
 */
export const generateAlbAssetProxyCode = (opts: {
  stripPrefix?: string;
  spaFallback?: boolean;
}): string => {
  const stripPrefix = JSON.stringify(opts.stripPrefix ?? '');
  const spaFallback = opts.spaFallback ? 'true' : 'false';
  return `const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client({});
const BUCKET = process.env.ASSET_BUCKET;
const KEY_PREFIX = process.env.ASSET_KEY_PREFIX || '';
const STRIP_PREFIX = ${stripPrefix};
const SPA_FALLBACK = ${spaFallback};

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

function stripBasePath(uri) {
  if (!STRIP_PREFIX) return uri;
  if (uri === STRIP_PREFIX) return '/';
  if (uri.indexOf(STRIP_PREFIX + '/') === 0) {
    const s = uri.substring(STRIP_PREFIX.length);
    return s.length === 0 ? '/' : s;
  }
  return uri;
}

// Extensionless paths resolve like the CloudFront static branch: SPA →
// /index.html; multi-page → /<path>/index.html (directory index).
function resolveIndex(uri) {
  const seg = uri.substring(uri.lastIndexOf('/') + 1);
  if (seg.indexOf('.') !== -1) return uri; // has an extension already
  if (SPA_FALLBACK) return '/index.html';
  if (uri.charAt(uri.length - 1) === '/') return uri + 'index.html';
  return uri + '/index.html';
}

async function readStream(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function fetchKey(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const buf = await readStream(res.Body);
  return { buf, contentType: res.ContentType || contentTypeFor(key) };
}

exports.handler = async (event) => {
  let uri = event.path || '/';
  uri = stripBasePath(uri);
  uri = resolveIndex(uri);
  const key = (KEY_PREFIX ? KEY_PREFIX.replace(/\\/+$/, '') + '/' : '') + uri.replace(/^\\/+/, '');
  try {
    const { buf, contentType } = await fetchKey(key);
    const isHtml = contentType.indexOf('text/html') === 0;
    return {
      statusCode: 200,
      statusDescription: '200 OK',
      isBase64Encoded: true,
      headers: {
        'content-type': contentType,
        // HTML must always revalidate; hashed assets are immutable-friendly but
        // the ALB path leaves long-term caching to the caller's own CDN if any.
        'cache-control': isHtml ? 'no-cache, no-store, must-revalidate' : 'public, max-age=31536000, immutable',
      },
      body: buf.toString('base64'),
    };
  } catch (err) {
    // On a miss, SPA sites fall back to index.html so client-side routing works.
    if (SPA_FALLBACK && key.slice(-10) !== 'index.html') {
      try {
        const idxKey = (KEY_PREFIX ? KEY_PREFIX.replace(/\\/+$/, '') + '/' : '') + 'index.html';
        const { buf } = await fetchKey(idxKey);
        return {
          statusCode: 200, statusDescription: '200 OK', isBase64Encoded: true,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, no-store, must-revalidate' },
          body: buf.toString('base64'),
        };
      } catch (_e) { /* fall through to 404 */ }
    }
    return {
      statusCode: 404, statusDescription: '404 Not Found', isBase64Encoded: false,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'Not Found',
    };
  }
};
`;
};
