// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `Access-Control-Max-Age` for preflight responses, in seconds.
 *
 * Chromium caps the preflight cache at 7200s and silently clamps anything
 * higher, so a larger value buys nothing while widening the window in which a
 * stale per-origin grant can be served. Shared by the Lambda handler and the
 * local dev server so the two can't drift.
 */
export const CORS_MAX_AGE = '7200';

/**
 * Parse a comma-separated CORS origin string into anchored RegExp patterns.
 *
 * Each entry is treated as a regex pattern:
 * - If it starts with `^`, it's used as-is (already anchored).
 * - Otherwise it's wrapped with `^...$` anchors.
 * - If the resulting regex is invalid, the entry is escaped and matched literally.
 *
 * @param raw - Comma-separated CORS patterns (e.g. `"https://example\\.com,^https?://localhost(:\\d+)?$"`)
 * @returns Array of anchored RegExp patterns
 */
export function parseCorsPatterns(raw: string): RegExp[] {
  return raw.split(',').map(p => p.trim()).filter(Boolean).map(pattern => {
    try {
      if (pattern.startsWith('^')) {
        return new RegExp(pattern);
      }
      return new RegExp(`^${pattern}$`);
    } catch {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`^${escaped}$`);
    }
  });
}

/**
 * Lazily-computed regex patterns for CORS origin validation.
 *
 * Computed on first access (not at module load) so that S3 config values
 * injected by `loadConfigToProcessEnv()` are available. Combines:
 * - `CORS_ALLOWED_ORIGINS` — set as Lambda env var by blocks-backend in sandbox mode
 * - `CORS_HOSTING_ORIGINS` — set from S3 config by the Hosting construct (CloudFront domain)
 *
 * The sentinel value `undefined` means "not yet computed".
 */
let _corsPatterns: RegExp[] | null | undefined;

/**
 * Get the lazily-computed CORS patterns from environment variables.
 *
 * Merges `CORS_ALLOWED_ORIGINS` and `CORS_HOSTING_ORIGINS` on first call,
 * then caches the result. Returns `null` if no patterns are configured.
 */
export function getCorsPatterns(): RegExp[] | null {
  if (_corsPatterns !== undefined) return _corsPatterns;

  const envOrigins = process.env.CORS_ALLOWED_ORIGINS ?? '';
  const hostingOrigins = process.env.CORS_HOSTING_ORIGINS ?? '';
  const combined = [envOrigins, hostingOrigins].filter(Boolean).join(',');

  if (!combined) {
    _corsPatterns = null;
    return null;
  }

  _corsPatterns = parseCorsPatterns(combined);
  return _corsPatterns;
}

/**
 * Check whether the given origin is allowed by the configured CORS patterns.
 *
 * @param origin - The `Origin` header value from the request
 * @returns `true` if the origin matches at least one pattern, `false` otherwise
 */
export function isOriginAllowed(origin: string): boolean {
  const patterns = getCorsPatterns();
  if (!origin || !patterns) return false;
  return patterns.some(re => re.test(origin));
}

/**
 * Distinct origins already warned about, so a caller retrying — or a bot
 * spraying bogus `Origin` values — can't amplify one log line per request now
 * that this helper runs on every response path.
 */
const warnedOrigins = new Set<string>();

/** Cap on {@link warnedOrigins} so an untrusted input can't grow it unbounded. */
const WARNED_ORIGINS_LIMIT = 100;

function warnDisallowedOriginOnce(origin: string): void {
  if (warnedOrigins.has(origin)) return;
  if (warnedOrigins.size < WARNED_ORIGINS_LIMIT) warnedOrigins.add(origin);
  const example = 'CORS_ALLOWED_ORIGINS=https://myapp\\.com,^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?$';
  console.warn(
    `[CORS] Origin "${origin}" is not allowed. Set the CORS_ALLOWED_ORIGINS environment variable to allow this origin. Example: ${example}`
  );
}

/**
 * Build the CORS response headers for a request origin.
 *
 * Only reflects the origin when it matches the configured allowlist. When no
 * allowlist is configured, or the origin is configured-but-not-allowed, no
 * `Access-Control-Allow-Origin` / `Access-Control-Allow-Credentials` headers
 * are emitted, so a disallowed origin is never reflected back.
 *
 * `Vary: Origin` is always emitted, including on the not-allowed path: the
 * response headers depend on the request `Origin`, so any shared cache (CDN,
 * forward proxy) must key on it or it can serve one origin's grant — or one
 * origin's *absence* of a grant — to a different origin.
 *
 * @param origin - The `Origin` header value from the request (may be empty)
 * @returns The CORS headers to merge into the response
 */
export function buildCorsHeaders(origin: string): Record<string, string> {
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (isOriginAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  } else if (origin) {
    warnDisallowedOriginOnce(origin);
  }
  return headers;
}

/**
 * Build a 403 Forbidden response for cross-origin requests from disallowed origins.
 */
export function corsRejection(): { statusCode: number; headers: Record<string, string>; body: string } {
  return {
    statusCode: 403,
    headers: { 'Content-Type': 'application/json', Vary: 'Origin' },
    body: JSON.stringify({ error: 'Forbidden: cross-origin request rejected' }),
  };
}

/**
 * Reset the lazy CORS pattern cache and the warned-origin set. **For testing only.**
 */
export function _resetCorsPatterns(): void {
  _corsPatterns = undefined;
  warnedOrigins.clear();
}
