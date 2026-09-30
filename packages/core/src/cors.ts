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
 * Split a comma-separated origin string into trimmed, non-empty entries. Shared
 * by {@link parseCorsPatterns} and {@link getCorsPatterns} so the regex and
 * hosting-literal channels tokenize the CSV identically.
 */
function splitOrigins(raw: string): string[] {
  return raw.split(',').map(p => p.trim()).filter(Boolean);
}

/**
 * Parse a comma-separated CORS origin string into anchored RegExp patterns.
 *
 * Each entry is compiled as `^(?:<entry>)$`: the `^` and `$` bind the whole
 * expression, so every branch of a top-level `|` alternation is end-anchored,
 * not just the last. A leading `^` or trailing `$` inside the entry is
 * redundant and harmless. If the resulting regex is invalid, the entry falls
 * back to a literal (escaped) match via {@link escapeOriginToPattern}.
 *
 * @param raw - Comma-separated CORS patterns (e.g. `"https://example\\.com,^https?://localhost(:\\d+)?$"`)
 * @returns Array of anchored RegExp patterns
 */
export function parseCorsPatterns(raw: string): RegExp[] {
  return splitOrigins(raw).map(pattern => {
    try {
      return new RegExp(`^(?:${pattern})$`);
    } catch {
      return new RegExp(escapeOriginToPattern(pattern));
    }
  });
}

/**
 * Escape a *literal* origin string into an anchored, regex-safe pattern.
 *
 * `getCorsPatterns()` compiles each `CORS_HOSTING_ORIGINS` entry into a RegExp,
 * so a literal origin injected by the framework (e.g. a CloudFront domain like
 * `https://d123.cloudfront.net`) must have its regex metacharacters escaped —
 * otherwise the unescaped dots become single-char wildcards and
 * `https://d123xcloudfrontxnet` would match. This escapes every metacharacter
 * and returns an already-anchored `^...$` pattern.
 *
 * Module-internal: both the {@link getCorsPatterns} hosting-literal channel and
 * the {@link parseCorsPatterns} invalid-regex fallback escape through this
 * helper (single source of truth). The `export` keyword is kept only so unit
 * tests can import it — `cors.ts` is not in any package export map, so this is
 * not a public API.
 *
 * Applied at **runtime** by `getCorsPatterns()` to each `CORS_HOSTING_ORIGINS`
 * entry, where the value is a resolved plain-string origin. It is deliberately
 * NOT called at synth by the Hosting construct: `hosting.distributionUrl` is an
 * unresolved CDK token there, so escaping it would corrupt the token marker into
 * a dead literal that never resolves to the real domain.
 *
 * @param origin - A literal origin URL (not a user-supplied regex pattern)
 * @returns An anchored regex source string of the form `^<escaped-origin>$`
 */
export function escapeOriginToPattern(origin: string): string {
  const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${escaped}$`;
}

/**
 * Lazily-computed regex patterns for CORS origin validation.
 *
 * Computed on first access (not at module load) so that S3 config values
 * injected by `loadConfigToProcessEnv()` are available. Combines two channels:
 * - `CORS_ALLOWED_ORIGINS` — user-supplied regex patterns (set as Lambda env var
 *   by blocks-backend in sandbox mode)
 * - `CORS_HOSTING_ORIGINS` — framework-injected literal origins (set from S3
 *   config by the Hosting construct, e.g. the resolved CloudFront domain)
 *
 * The sentinel value `undefined` means "not yet computed".
 */
let _corsPatterns: RegExp[] | null | undefined;

/**
 * Get the lazily-computed CORS patterns from environment variables, then cache.
 *
 * The two source env vars are compiled via DIFFERENT paths (they are never
 * comma-joined into one string):
 * - `CORS_ALLOWED_ORIGINS` is compiled by {@link parseCorsPatterns} as regex
 *   patterns (user-supplied; the `.*` escape hatch and custom regex keep working).
 * - `CORS_HOSTING_ORIGINS` holds resolved literal origins; each is escaped by
 *   {@link escapeOriginToPattern} before compiling so a domain like
 *   `d123.cloudfront.net` matches literally (its dots are not wildcards).
 *
 * Returns `null` if no patterns are configured.
 */
export function getCorsPatterns(): RegExp[] | null {
  if (_corsPatterns !== undefined) return _corsPatterns;

  const envOrigins = process.env.CORS_ALLOWED_ORIGINS ?? '';
  const hostingOrigins = process.env.CORS_HOSTING_ORIGINS ?? '';

  // Regex channel: user-supplied patterns, compiled as-is.
  const regexPatterns = envOrigins ? parseCorsPatterns(envOrigins) : [];
  // Literal channel: framework-injected resolved origins, escaped so regex
  // metacharacters (notably dots) match literally rather than as wildcards.
  const hostingPatterns = splitOrigins(hostingOrigins)
    .map(origin => new RegExp(escapeOriginToPattern(origin)));

  const all = [...regexPatterns, ...hostingPatterns];
  _corsPatterns = all.length ? all : null;
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
