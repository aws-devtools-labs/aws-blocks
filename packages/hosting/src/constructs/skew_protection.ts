// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  BUILD_ID_PATTERN,
  RedirectEntry,
  generateRedirectCheckSnippet,
  validateRedirects,
} from '../defaults.js';
import { HostingError } from '../hosting_error.js';

/**
 * Configuration for cookie-based skew protection.
 *
 * When enabled, CloudFront Functions route returning users to the build
 * they originally started their session on (via a cookie), preventing
 * asset mismatches during rolling deployments.
 */
export type SkewProtectionConfig = {
  enabled: boolean;
  /**
   * How long (in seconds) old-build cookies remain valid.
   * After this period, the user is routed to the latest build.
   * @default 86400 (24 hours)
   */
  maxAge?: number;
};

/** Default cookie max-age in seconds (24 hours). */
const DEFAULT_MAX_AGE = 86400;

/** Cookie name used to pin a user session to a specific build. */
const COOKIE_NAME = '__dpl';

/**
 * Generates CloudFront Function code for the viewer-request event.
 *
 * This function:
 * 1. Checks manifest redirects — if match, returns redirect response immediately
 * 2. Reads the `__dpl` cookie from the incoming request
 * 3. If present and valid, rewrites the URI to that build's prefix
 * 4. If absent, uses the current (deploy-time) build ID
 * 5. Appends `index.html` for directory-style paths
 * @param buildId - The current build ID baked in at synth time
 * @param redirects - Manifest redirect entries to evaluate before build-id rewrite
 * @returns CloudFront Function source code (JavaScript)
 */
export const generateSkewProtectionViewerRequestCode = (
  buildId: string,
  redirects: RedirectEntry[] = [],
  options?: {
    spaFallback?: boolean;
    basePath?: string;
  },
): string => {
  validateBuildId(buildId);
  validateRedirects(redirects);
  const redirectSnippet = generateRedirectCheckSnippet(redirects);
  const basePath = options?.basePath;
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
  const basePathStrip = basePath
    ? `  if (uri.indexOf(__bp) === 0) {
    uri = uri.substring(__bp.length);
    if (uri.length === 0) { uri = '/'; }
  }
`
    : '';
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
${basePathRedirect}${basePathStrip}  var buildId = '${buildId}';
  var cookie = request.cookies['${COOKIE_NAME}'];
  if (cookie) {
    var val = cookie.value;
    if (/^[a-zA-Z0-9-]{1,64}$/.test(val)) {
      buildId = val;
    }
  }
${rewriteBlock}
  request.uri = '/builds/' + buildId + uri;
  return request;
}`;
};

/**
 * Generates CloudFront Function code for the viewer-response event.
 *
 * This function:
 * 1. Inspects the Content-Type response header
 * 2. Only for HTML responses (text/html), sets the `__dpl` cookie
 *    to the current build ID — pinning the user's session to this build
 * 3. Non-HTML responses (JS, CSS, images) are passed through unchanged
 * @param buildId - The current build ID baked in at synth time
 * @param maxAge  - Cookie lifetime in seconds (default: 86400)
 * @returns CloudFront Function source code (JavaScript)
 */
export const generateSkewProtectionViewerResponseCode = (
  buildId: string,
  maxAge: number = DEFAULT_MAX_AGE,
): string => {
  validateBuildId(buildId);
  if (maxAge < 0 || maxAge > 2592000) {
    throw new HostingError('InvalidSkewProtectionMaxAgeError', {
      message: `maxAge must be between 0 and 2592000 (30 days). Got: ${maxAge}`,
      resolution: 'Provide a maxAge value between 0 and 2592000 seconds.',
    });
  }
  // Status-gated cookie set: only pin a user to *this* build when the
  // origin produced a successful HTML response. Without the gate, a
  // viewer hitting a 503 mid-deploy gets a __dpl cookie pointing at
  // the broken build for maxAge seconds — every subsequent request
  // sticks to the bad version even after the fleet recovers. Sticky
  // failures are felt loudest during a rolling deploy where one PoP
  // briefly serves errors while others are healthy.
  return `function handler(event) {
  var response = event.response;
  var status = response.statusCode;
  if (status >= 400) { return response; }
  var contentType = response.headers['content-type'] ? response.headers['content-type'].value : '';
  if (contentType.indexOf('text/html') >= 0) {
    response.cookies['${COOKIE_NAME}'] = { value: '${buildId}', attributes: 'Path=/; SameSite=Lax; Max-Age=${maxAge}' };
  }
  return response;
}`;
};

/** Validates a build ID string. */
const validateBuildId = (buildId: string): void => {
  if (!BUILD_ID_PATTERN.test(buildId)) {
    throw new HostingError('InvalidBuildIdError', {
      message: `Build ID must be alphanumeric with hyphens, max 64 chars. Got: ${buildId}`,
      resolution:
        'Ensure build ID contains only letters, numbers, and hyphens.',
    });
  }
};
