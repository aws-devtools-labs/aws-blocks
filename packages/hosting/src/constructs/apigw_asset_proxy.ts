/**
 * Static asset-proxy Lambda for API Gateway v2 / Lambda Function URL front doors.
 *
 * Both API Gateway HTTP API and Lambda Function URLs invoke a Lambda with the
 * **payload format 2.0** event (`rawPath`, `requestContext.http.method`,
 * `headers`, `cookies`, `body`, `isBase64Encoded`) and expect a 2.0 response
 * (`{ statusCode, headers, cookies?, body, isBase64Encoded }`). This is a
 * DIFFERENT envelope than the ALB↔Lambda contract (`alb_asset_proxy.ts`), so it
 * gets its own generator; the core logic (strip prefix, directory-index / SPA
 * fallback, read `builds/<buildId>/…` from the private bucket) is the same as
 * the ALB and CloudFront static branches.
 *
 * Emitted INLINE (no bundle step) — uses only `@aws-sdk/client-s3` (present in
 * the Node.js Lambda runtime).
 */
export const generateApiGwAssetProxyCode = (opts: {
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
  if (uri.indexOf(STRIP_PREFIX + '/') === 0) { const s = uri.substring(STRIP_PREFIX.length); return s.length === 0 ? '/' : s; }
  return uri;
}
function resolveIndex(uri) {
  const seg = uri.substring(uri.lastIndexOf('/') + 1);
  if (seg.indexOf('.') !== -1) return uri;
  if (SPA_FALLBACK) return '/index.html';
  if (uri.charAt(uri.length - 1) === '/') return uri + 'index.html';
  return uri + '/index.html';
}
async function readStream(body) { const chunks = []; for await (const c of body) chunks.push(c); return Buffer.concat(chunks); }
async function fetchKey(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return { buf: await readStream(res.Body), contentType: res.ContentType || contentTypeFor(key) };
}
function keyFor(uri) {
  return (KEY_PREFIX ? KEY_PREFIX.replace(/\\/+$/, '') + '/' : '') + uri.replace(/^\\/+/, '');
}

exports.handler = async (event) => {
  // Payload 2.0: rawPath is the request path (both API Gateway HTTP API and Function URLs).
  let uri = event.rawPath || (event.requestContext && event.requestContext.http && event.requestContext.http.path) || '/';
  uri = resolveIndex(stripBasePath(uri));
  const key = keyFor(uri);
  try {
    const { buf, contentType } = await fetchKey(key);
    const isHtml = contentType.indexOf('text/html') === 0;
    return {
      statusCode: 200,
      headers: {
        'content-type': contentType,
        'cache-control': isHtml ? 'no-cache, no-store, must-revalidate' : 'public, max-age=31536000, immutable',
      },
      isBase64Encoded: true,
      body: buf.toString('base64'),
    };
  } catch (err) {
    if (SPA_FALLBACK && key.slice(-10) !== 'index.html') {
      try {
        const { buf } = await fetchKey(keyFor('/index.html'));
        return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, no-store, must-revalidate' }, isBase64Encoded: true, body: buf.toString('base64') };
      } catch (_e) { /* fall through */ }
    }
    return { statusCode: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, isBase64Encoded: false, body: 'Not Found' };
  }
};
`;
};
