import { type AssetProxyOptions, assetProxyCoreJs } from './asset_proxy_core.js';

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
 *   - directory-index / SPA fallback for extensionless paths (the SPA fallback
 *     skips `/.well-known/`, as on CloudFront),
 *   - map to `builds/<buildId>/<path>` and return the bytes with the object's
 *     Content-Type and its stored Cache-Control (a default only when the
 *     object has none); a miss is a 404 — a missing file with an extension
 *     (`/missing.js`, `/.env`) never falls back to `index.html`.
 *
 * It also applies the app's rules as the CloudFront door does — redirects
 * (first match, wildcard tail spliced), per-pattern response headers on a
 * successful response, and the app's error pages (404 for a missing file, 500
 * when S3 fails). The serving logic is shared with the API Gateway asset proxy
 * (`asset_proxy_core.ts`); this file adds the ALB envelope.
 */

/**
 * Build the inline handler source for the asset-proxy Lambda.
 *
 * @param opts.bucketEnv     env var name holding the bucket name (default `ASSET_BUCKET`)
 * @param opts.keyPrefixEnv  env var name holding the `builds/<id>` key prefix (default `ASSET_KEY_PREFIX`)
 * @param opts.stripPrefix   basePath/assetPrefix to strip from the URL before lookup (default '')
 * @param opts.spaFallback   serve `index.html` on a miss (SPA) vs a real 404
 * @param opts.redirects     the app's redirects (first match wins), answered before any S3 read
 * @param opts.headers       the app's per-pattern response headers, applied to a successful response
 * @param opts.errorPages    the app's error pages (`404.html` / `500.html` keys under the build prefix)
 */
export const generateAlbAssetProxyCode = (opts: AssetProxyOptions): string => `${assetProxyCoreJs(opts)}
const STATUS_TEXT = { 200: 'OK', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 404: 'Not Found', 500: 'Internal Server Error' };

exports.handler = async (event) => {
  const res = await blocksServe(event.path || '/', event.headers);
  return {
    statusCode: res.statusCode,
    statusDescription: res.statusCode + ' ' + (STATUS_TEXT[res.statusCode] || ''),
    isBase64Encoded: res.isBase64Encoded,
    headers: res.headers,
    body: res.body,
  };
};
`;
