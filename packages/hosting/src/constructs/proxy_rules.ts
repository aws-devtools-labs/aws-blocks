// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The app's rules (redirects, per-pattern response headers) and the static
 * path resolution, as JavaScript source shared by every place that serves
 * them outside the CloudFront door's KVS router:
 *
 * - the asset-proxy Lambdas of the ALB and API Gateway doors, and the ALB
 *   door's API forwarder (Node.js);
 * - the static-asset viewer-request function of the stacked door's CloudFront
 *   edge (CloudFront Functions, JS 2.0).
 *
 * The matching is the edge router's own code (`CF_MATCH_HELPERS`,
 * `redirectRowsJs`, `headerRowsJs` — the same code `cf.redirects` and
 * `cf.headers` ship), so a pattern matches, a wildcard redirect splices its
 * tail, and every matching header rule applies exactly as on the CloudFront
 * door. The emitted source is ES5-style (`var`, `function`), valid in both
 * runtimes.
 *
 * @internal Framework-only.
 */
import { Annotations } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import type { DoorHeaderRule, DoorRedirect } from './front_door.js';
import { CF_MATCH_HELPERS, headerRowsJs, redirectRowsJs } from './kvs_router.js';

/** The app's rules, as a proxy applies them. */
export type ProxyRules = {
  /** Redirects, first match wins (`DoorInput.app.redirects`). */
  readonly redirects?: readonly DoorRedirect[];
  /** Per-pattern response headers, every match applies (`DoorInput.app.headers`). */
  readonly headers?: readonly DoorHeaderRule[];
};

/**
 * Static path resolution, as the CloudFront static branch does it:
 * `resolveIndex(uri, spa)` maps an extensionless path to `/index.html` for a
 * single-page app (except under `/.well-known/`), and to its directory index
 * (`/about` → `/about/index.html`) otherwise; a path with an extension is
 * looked up as-is.
 */
export const STATIC_RESOLVE_JS = `function resolveIndex(uri, spa) {
  var seg = uri.substring(uri.lastIndexOf('/') + 1);
  if (spa) {
    return seg.indexOf('.') === -1 && uri.indexOf('/.well-known/') !== 0 ? '/index.html' : uri;
  }
  if (uri.charAt(uri.length - 1) === '/') return uri + 'index.html';
  if (seg.indexOf('.') !== -1) return uri;
  return uri + '/index.html';
}`;

/**
 * The rules as JavaScript source: the pattern matcher and basePath strip
 * (`matchPattern`, `stripBasePath`), {@link STATIC_RESOLVE_JS}, and
 *
 * - `blocksRedirect(uri)` → `{ statusCode, location }` for the first matching
 *   redirect (wildcard tail spliced), or `null`;
 * - `blocksHeaders(uri)` → `{ name: value }` from every matching header rule
 *   (names lower-cased; a later rule wins a repeated name).
 *
 * @param rules the app's redirects and header rules.
 * @returns the source, to inline ahead of a handler.
 */
export const proxyRulesJs = (rules: ProxyRules): string => {
  const redirects = JSON.stringify((rules.redirects ?? []).map((r) => [r.source, r.destination, r.statusCode]));
  const headers = JSON.stringify((rules.headers ?? []).map((h) => [h.pattern, h.headers]));
  return `${CF_MATCH_HELPERS}
${STATIC_RESOLVE_JS}
var BLOCKS_REDIRECTS = ${redirects};
var BLOCKS_HEADER_RULES = ${headers};
function blocksRedirectResponse(uri) {
${redirectRowsJs('BLOCKS_REDIRECTS', '  ')}
  return null;
}
function blocksRedirect(uri) {
  var r = blocksRedirectResponse(uri);
  return r ? { statusCode: r.statusCode, location: r.headers.location.value } : null;
}
function blocksHeaders(uri) {
  var response = { headers: {} };
${headerRowsJs('BLOCKS_HEADER_RULES', '  ')}
  var out = {};
  for (var name in response.headers) { out[name] = response.headers[name].value; }
  return out;
}`;
};

/** What a regional door's proxies can't reach, for {@link warnRulesNotApplied}. */
export type UnreachedByProxies = {
  /** The door's name in the message (e.g. `ALB`). */
  readonly door: string;
  /** The app's header rules. */
  readonly headers: readonly DoorHeaderRule[];
  /** Whether the app has error pages. */
  readonly errorPages: boolean;
  /** The server (SSR) is invoked directly, not through a proxy. */
  readonly server: boolean;
  /** Image optimization is invoked directly. */
  readonly image: boolean;
  /** The API is proxied natively (no forwarder Lambda), when the app has one. */
  readonly nativeApi: boolean;
  /** The API is relayed (by a forwarder or natively), when the app has one. */
  readonly api: boolean;
};

/**
 * Warn at synth (`@aws-blocks/hosting:DoorRulesNotApplied`) naming exactly
 * which of the app's rules a regional door's proxies can't apply: responses
 * the door routes straight to a function or the backend never pass through
 * the asset proxy or the API forwarder, so header rules and error pages don't
 * reach them (the CloudFront door applies both to every response). Redirects
 * are always applied (every redirect source is routed to the asset proxy).
 *
 * @param scope the door construct.
 * @param what what the door's proxies don't reach.
 */
export const warnRulesNotApplied = (scope: IConstruct, what: UnreachedByProxies): void => {
  const notes: string[] = [];
  if (what.headers.length > 0) {
    const missed = [
      what.server ? 'server-rendered (SSR) responses' : undefined,
      what.image ? 'image-optimization responses' : undefined,
      what.nativeApi ? 'API responses (`/aws-blocks/*` and raw routes)' : undefined,
    ].filter((m): m is string => m !== undefined);
    if (missed.length > 0) {
      notes.push(
        `the ${what.headers.length} per-pattern response-header rule(s) are not applied to ${missed.join(', ')}: ` +
          'the door routes those straight to the function or backend, past the proxies that apply them',
      );
    }
  }
  if (what.errorPages && (what.server || what.api)) {
    const passed = [what.server ? 'the server' : undefined, what.api ? 'the API' : undefined].filter(Boolean).join(' and ');
    notes.push(
      `the error pages are served only for missing static files (404) and S3 failures (500); error responses from ${passed} pass through unchanged`,
    );
  }
  if (notes.length === 0) return;
  Annotations.of(scope).addWarningV2(
    '@aws-blocks/hosting:DoorRulesNotApplied',
    `${what.door} front door: ${notes.join('; ')}. The CloudFront door (or the stacked door's edge) applies them to every response.`,
  );
};
