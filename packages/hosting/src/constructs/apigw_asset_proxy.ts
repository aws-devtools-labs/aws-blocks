import { type AssetProxyOptions, assetProxyCoreJs } from './asset_proxy_core.js';

/**
 * Static asset-proxy Lambda for API Gateway v2 / Lambda Function URL front doors.
 *
 * Both API Gateway HTTP API and Lambda Function URLs invoke a Lambda with the
 * **payload format 2.0** event (`rawPath`, `requestContext.http.method`,
 * `headers`, `cookies`, `body`, `isBase64Encoded`) and expect a 2.0 response
 * (`{ statusCode, headers, cookies?, body, isBase64Encoded }`). This is a
 * DIFFERENT envelope than the ALB↔Lambda contract (`alb_asset_proxy.ts`), so it
 * gets its own generator; the core logic (strip prefix, directory-index / SPA
 * fallback for extensionless paths, read `builds/<buildId>/…` from the private
 * bucket, serve the object's stored Cache-Control, 404 on a miss) is the same
 * as the ALB and CloudFront static branches.
 *
 * Emitted INLINE (no bundle step) — uses only `@aws-sdk/client-s3` (present in
 * the Node.js Lambda runtime).
 *
 * Like the ALB asset proxy, it applies the app's rules as the CloudFront door
 * does — redirects, per-pattern response headers on a successful response, and
 * the app's error pages — through the shared serving logic
 * (`asset_proxy_core.ts`).
 */
/**
 * Build the inline handler source for the API Gateway / Function URL asset-proxy Lambda.
 * The function reads its bucket and build prefix from the environment
 * ({@link assetProxyEnvironment}) and needs read access to the bucket.
 *
 * @param opts.stripPrefix   basePath/assetPrefix to strip from the URL before lookup (default '')
 * @param opts.spaFallback   serve `index.html` on a miss (SPA) vs a real 404
 * @param opts.redirects     the app's redirects (first match wins), answered before any S3 read
 * @param opts.headers       the app's per-pattern response headers, applied to a successful response
 * @param opts.errorPages    the app's error pages (`404.html` / `500.html` keys under the build prefix)
 * @param opts.imageFallback answer the framework image endpoints with the source image (no image function)
 */
export const generateApiGwAssetProxyCode = (opts: AssetProxyOptions): string => `${assetProxyCoreJs(opts)}
exports.handler = async (event) => {
  // Payload 2.0 (HTTP API / Function URL): rawPath. Payload 1.0 (REST API): path.
  // The REST API front door invokes this Lambda with the v1 envelope, so read
  // both — the response shape below ({statusCode, headers, isBase64Encoded, body})
  // is valid for a v1 and a v2 proxy integration alike.
  const uri = event.rawPath || (event.requestContext && event.requestContext.http && event.requestContext.http.path) || event.path || '/';
  const image = blocksImageSource(uri, event.queryStringParameters);
  if (image && image.redirect) {
    return secure({ statusCode: 302, headers: { location: image.redirect, 'cache-control': 'no-cache' }, body: '', isBase64Encoded: false });
  }
  if (image && image.status) return secure(await errorResponse(image.status));
  return blocksServe(image ? image.uri : uri, event.headers);
};
`;
