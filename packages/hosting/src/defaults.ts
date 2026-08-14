/**
 * Shared default values for the hosting package.
 */

import { randomUUID } from 'node:crypto';
import { HostingError } from './hosting_error.js';

/**
 * S3 object key for the SSR error page used in CloudFront 5xx error responses.
 */
export const ERROR_PAGE_KEY = '_error.html';

/**
 * S3 object key for the built-in default 404 page. Used for multi-page
 * static sites (`staticAssets.spaFallback === false`) that did NOT emit
 * their own `404.html` and whose user did not supply `errorPages.notFound`.
 * Without it, a missing path on such a site falls through to CloudFront's
 * raw S3-OAC 403 XML body. This mirrors the SSR default error page so all
 * deploy shapes get a branded not-found page instead of a raw error.
 */
export const NOT_FOUND_PAGE_KEY = '_not_found.html';

/**
 * Default port for SSR server processes (Lambda Web Adapter).
 */
export const SSR_DEFAULT_PORT = 3000;

/**
 * Build ID validation pattern: alphanumeric with hyphens, max 64 chars.
 */
export const BUILD_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

/**
 * Generate CloudFront Function code that prepends the build ID prefix to request URIs.
 * This enables atomic deploys — all assets are stored under `builds/{buildId}/`.
 */
export const generateBuildIdFunctionCode = (buildId: string): string => {
  if (!BUILD_ID_PATTERN.test(buildId)) {
    throw new HostingError('InvalidBuildIdError', {
      message: `Build ID must be alphanumeric with hyphens, max 64 chars. Got: ${buildId}`,
      resolution:
        'Ensure build ID contains only letters, numbers, and hyphens.',
    });
  }
  return `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  // Resolve directory-style and bare paths to <name>/index.html so the
  // S3 origin (REST API, no website-mode auto-resolution) can find them.
  // Triggers when the path ends with "/" or has no file extension.
  if (uri.endsWith('/')) {
    uri = uri + 'index.html';
  } else {
    var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
    if (lastSegment.indexOf('.') === -1) {
      uri = uri + '/index.html';
    }
  }
  // Prepend build ID prefix for atomic deployment
  request.uri = '/builds/${buildId}' + uri;
  return request;
}`;
};

/**
 * Generate a unique Build ID based on the current timestamp.
 */
export const generateBuildId = (): string => {
  const timestamp = Date.now().toString(36);
  const unique = randomUUID().split('-')[0];
  return `${timestamp}-${unique}`;
};

/**
 * Manifest redirect entry. Mirrors `Redirect` in `manifest/types.ts` but
 * imported by string here to avoid a circular dep.
 */
export type RedirectEntry = {
  source: string;
  destination: string;
  statusCode: 301 | 302 | 307 | 308;
};

/**
 * Generate CloudFront Function code that handles manifest redirects + the
 * build-id rewrite for static assets.
 *
 * Why combined: CloudFront allows exactly one function per behavior per
 * event type. The default behavior already needs the build-id rewrite for
 * static assets; we tack the redirect check onto the same function so a
 * matching redirect short-circuits before the rewrite runs.
 *
 * Match semantics:
 *   - Exact match: `/old-page` matches only `/old-page`.
 *   - Suffix wildcard: `/old/*` matches `/old/anything/here`.
 *   - The captured tail is appended to the destination if the destination
 *     also ends with `*` (e.g. `/old/* -> /new/*` rewrites the tail).
 *
 * Limit: CloudFront Functions are capped at 10 KB compiled and 1 ms CPU.
 * Encoding hundreds of redirects would blow that budget — we cap at 100
 * entries here and throw at synth time if exceeded. Customers with more
 * should consolidate or use middleware.
 */
export const MAX_REDIRECTS_IN_FUNCTION = 100;

/**
 * Generate the JS source of a CloudFront viewer-request handler that
 * checks `event.request.uri` against the manifest's redirect table and
 * returns a 30x response on match. Returns just the redirect-check
 * snippet (no `handler` wrapper) so it can be composed with other logic
 * in callers that already have their own handler.
 */
export const generateRedirectCheckSnippet = (
  redirects: RedirectEntry[],
): string => {
  if (redirects.length === 0) return '';
  const table = JSON.stringify(redirects);
  return `
  var __redirects = ${table};
  for (var __i = 0; __i < __redirects.length; __i++) {
    var __r = __redirects[__i];
    var __src = __r.source;
    var __matched = false;
    var __tail = '';
    if (__src.indexOf('*') === -1) {
      if (uri === __src) { __matched = true; }
    } else if (__src.charAt(__src.length - 1) === '*') {
      var __prefix = __src.substring(0, __src.length - 1);
      if (uri.indexOf(__prefix) === 0) {
        __matched = true;
        __tail = uri.substring(__prefix.length);
      }
    }
    if (__matched) {
      var __dest = __r.destination;
      // Guard on the DESTINATION trailing '*', not __tail truthiness: an exact
      // hit on a wildcard prefix yields __tail '' , and a truthiness guard would
      // skip the splice and leak a literal '*' into Location. Always strip the
      // trailing '*' and append the (possibly empty) tail.
      if (__dest.charAt(__dest.length - 1) === '*') {
        __dest = __dest.substring(0, __dest.length - 1) + (__tail || '');
      }
      return {
        statusCode: __r.statusCode,
        statusDescription: 'Redirect',
        headers: { location: { value: __dest } },
      };
    }
  }`;
};

/**
 * Validates an array of redirect entries against CloudFront Function limits.
 * Throws if the redirect count exceeds the function size cap or if any
 * entry uses an invalid HTTP status code.
 */
export const validateRedirects = (redirects: RedirectEntry[]): void => {
  if (redirects.length > MAX_REDIRECTS_IN_FUNCTION) {
    throw new HostingError('TooManyRedirectsError', {
      message: `Manifest declares ${redirects.length} redirects, but CloudFront Functions are limited to ~10 KB. Cap is ${MAX_REDIRECTS_IN_FUNCTION}.`,
      resolution:
        'Consolidate redirect rules or move them to your SSR handler / middleware.',
    });
  }
  for (const r of redirects) {
    if (![301, 302, 307, 308].includes(r.statusCode)) {
      throw new HostingError('InvalidRedirectError', {
        message: `Redirect status ${r.statusCode} is not a redirect status`,
        resolution: 'Use 301, 302, 307, or 308.',
      });
    }
  }
};

/**
 * Generate CloudFront Function code for the static-asset behavior:
 * checks redirects first, then prepends the build-id prefix and
 * resolves directory-index paths.
 *
 * Why combined: CloudFront allows exactly one function per behavior per
 * event type. Static behaviors need both redirect-handling and
 * build-id-rewrite, so we compose them into one handler.
 */
export const generateBuildIdAndRedirectFunctionCode = (
  buildId: string,
  redirects: RedirectEntry[] = [],
  basePath?: string,
  options?: {
    spaFallback?: boolean;
  },
): string => {
  if (!BUILD_ID_PATTERN.test(buildId)) {
    throw new HostingError('InvalidBuildIdError', {
      message: `Build ID must be alphanumeric with hyphens, max 64 chars. Got: ${buildId}`,
      resolution:
        'Ensure build ID contains only letters, numbers, and hyphens.',
    });
  }
  validateRedirects(redirects);
  const redirectSnippet = generateRedirectCheckSnippet(redirects);
  // basePath canonical-redirect: when basePath is set, the bare domain
  // root and any path NOT under basePath should 308-redirect to the
  // basePath-prefixed equivalent. Without this the SSR Lambda's
  // catch-all serves prerendered content from bare paths, breaking the
  // basePath contract documented in DeployManifest.basePath.
  //
  // Order matters: this runs BEFORE the basePath strip, so requests
  // that DO start with basePath fall through to the strip + rewrite
  // path unchanged. Requests that don't get redirected back to the
  // basePath-prefixed URL (browser then re-requests, hitting the
  // /<basePath>/* CloudFront behavior).
  const basePathRedirect = basePath
    ? `  var __bp = ${JSON.stringify(basePath)};
  if (uri !== __bp && uri.indexOf(__bp + '/') !== 0) {
    var __target = uri === '/' ? __bp + '/' : __bp + uri;
    return {
      statusCode: 308,
      statusDescription: 'Permanent Redirect',
      headers: { location: { value: __target } },
    };
  }
`
    : '';
  // basePath strip on static behaviors: S3 stores objects under
  // /builds/<id>/foo.css, not /builds/<id>/<basePath>/foo.css. Strip the
  // prefix after redirects evaluate but before the build-id rewrite so
  // assets resolve. SSR/compute behaviors KEEP basePath — framework
  // internal routing expects it.
  const basePathStrip = basePath
    ? `  if (uri.indexOf(__bp) === 0) {
    uri = uri.substring(__bp.length);
    if (uri.length === 0) { uri = '/'; }
  }
`
    : '';
  // SPA fallback: for single-page apps, navigation requests (no file
  // extension) should serve /index.html. Asset requests (.js, .css, etc.)
  // pass through unchanged — if the file is missing, S3 returns 403/404
  // which is correct (broken asset link, not a client-side route).
  const spaFallback = options?.spaFallback ?? false;
  const rewriteBlock = spaFallback
    ? `  var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
  var hasExtension = lastSegment.indexOf('.') !== -1;
  var isWellKnown = uri.startsWith('/.well-known/');
  if (!hasExtension && !isWellKnown) {
    uri = '/index.html';
  }`
    : `  if (uri.endsWith('/')) {
    uri = uri + 'index.html';
  } else {
    var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
    if (lastSegment.indexOf('.') === -1) {
      uri = uri + '/index.html';
    }
  }`;
  return `function handler(event) {
  var request = event.request;
  var uri = request.uri;
${redirectSnippet}
${basePathRedirect}${basePathStrip}${rewriteBlock}
  request.uri = '/builds/${buildId}' + uri;
  return request;
}`;
};

/**
 * Generate a CloudFront Function that strips a Next.js `assetPrefix`
 * from the URI before the build-id rewrite runs. Used on
 * `/<prefix>/_next/*` cache behaviors so prefixed asset URLs (Next's
 * default emit when `assetPrefix` is set) resolve to the same S3
 * objects as unprefixed `/_next/*` paths.
 *
 * Why a separate function: combining strip + build-id-rewrite + redirect
 * check in one inline string blows past CloudFront's 10 KB per-function
 * cap when redirects[] is large. Keeping them split lets us evolve
 * each independently and stay within the cap.
 *
 * `assetPrefix` must start with `/` and not end with `/`. The function
 * embeds it as a literal string for cheapest possible runtime behavior
 * — no regex, no allocation beyond the substring slice.
 */
export const generateAssetPrefixStripFunctionCode = (
  buildId: string,
  assetPrefix: string,
): string => {
  if (!BUILD_ID_PATTERN.test(buildId)) {
    throw new HostingError('InvalidBuildIdError', {
      message: `Build ID must be alphanumeric with hyphens, max 64 chars. Got: ${buildId}`,
      resolution:
        'Ensure build ID contains only letters, numbers, and hyphens.',
    });
  }
  if (!assetPrefix.startsWith('/') || assetPrefix.endsWith('/')) {
    throw new HostingError('InvalidAssetPrefixError', {
      message: `assetPrefix must start with / and not end with /. Got: ${assetPrefix}`,
      resolution:
        'Normalize the prefix to a leading-slash, no-trailing-slash form before passing it.',
    });
  }
  return `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var prefix = ${JSON.stringify(assetPrefix)};
  if (uri.indexOf(prefix) === 0) {
    uri = uri.substring(prefix.length);
    if (uri.length === 0) { uri = '/'; }
  }
  if (uri.endsWith('/')) {
    uri = uri + 'index.html';
  } else {
    var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
    if (lastSegment.indexOf('.') === -1) {
      uri = uri + '/index.html';
    }
  }
  request.uri = '/builds/${buildId}' + uri;
  return request;
}`;
};

/**
 * Generate CloudFront Function code for compute-origin behaviors:
 * checks redirects first, then propagates the Host header to
 * x-forwarded-host so the SSR handler can construct correct public URLs.
 *
 * When basePath is set, also emits a 308 canonical redirect for any URI
 * that does not start with the basePath. This mirrors the redirect
 * applied on static behaviors via generateBuildIdAndRedirectFunctionCode
 * — both functions run on different behaviors but enforce the same
 * basePath contract from `DeployManifest.basePath`.
 */
export const generateForwardedHostAndRedirectFunctionCode = (
  redirects: RedirectEntry[] = [],
  basePath?: string,
): string => {
  validateRedirects(redirects);
  const redirectSnippet = generateRedirectCheckSnippet(redirects);
  const basePathRedirect = basePath
    ? `  var __bp = ${JSON.stringify(basePath)};
  if (uri !== __bp && uri.indexOf(__bp + '/') !== 0) {
    var __target = uri === '/' ? __bp + '/' : __bp + uri;
    return {
      statusCode: 308,
      statusDescription: 'Permanent Redirect',
      headers: { location: { value: __target } },
    };
  }
`
    : '';
  return `function handler(event) {
  var request = event.request;
  var uri = request.uri;
${redirectSnippet}
${basePathRedirect}  var host = request.headers.host ? request.headers.host.value : undefined;
  if (host) { request.headers["x-forwarded-host"] = { value: host }; }
  return request;
}`;
};
