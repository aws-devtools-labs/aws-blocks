// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import parseCacheControl from 'parse-cache-control';
import { HostingError } from '../../hosting_error.js';

// RFC 7234 § 5.2 — known directives. parse-cache-control accepts
// unknown identifiers as boolean directives (so `'foo'` parses as
// `{foo: true}`), which is too permissive to catch user typos. Cross-
// check against this allowlist after parse to reject unknown tokens.
const KNOWN_DIRECTIVES = new Set([
  'max-age',
  'max-stale',
  'min-fresh',
  'must-revalidate',
  'must-understand',
  'no-cache',
  'no-store',
  'no-transform',
  'only-if-cached',
  'private',
  'proxy-revalidate',
  'public',
  's-maxage',
  'stale-if-error',
  'stale-while-revalidate',
  'immutable',
]);

/**
 * Validate a `Cache-Control` header value via `parse-cache-control`
 * (RFC 7234) augmented with a directive-name allowlist. Throws
 * `InvalidCacheControlError` when the value cannot be parsed OR
 * contains an unknown directive. Used at build time to catch typos
 * before they ship — CloudFront accepts any opaque string, so without
 * this check a typo only surfaces when a downstream cache rejects it.
 *
 * `parse-cache-control` returns `null` on malformed numeric directives
 * (`max-age=abc`) but accepts unknown identifiers as boolean tokens.
 * The allowlist closes that gap so `not-a-directive` and `''` fail
 * with `HostingError` carrying the caller's `context`.
 */
export const validateCacheControl = (value: string, context: string): void => {
  const parsed = parseCacheControl(value);
  const fail = () => {
    throw new HostingError('InvalidCacheControlError', {
      message: `Invalid Cache-Control value "${value}" in ${context}.`,
      resolution:
        'Check syntax against RFC 7234. Valid examples: ' +
        '"public, max-age=3600", "no-store", "private, max-age=0, must-revalidate".',
    });
  };
  if (parsed === null) fail();
  const keys = Object.keys(parsed!);
  if (keys.length === 0) fail();
  for (const key of keys) {
    if (!KNOWN_DIRECTIVES.has(key)) fail();
  }
};
