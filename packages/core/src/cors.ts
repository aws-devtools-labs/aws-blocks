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
 * A plain origin: `scheme://host[:port]` with an optional trailing `/`, and no
 * regex syntax other than `.` (which, in a plain origin, is a literal dot). The
 * host part is either:
 * - a name or IPv4 address, excluding whitespace, `/` (no path) and every regex
 *   metacharacter except `.` — `* + ? ^ $ { } ( ) | [ ] \`; or
 * - a bracketed IPv6 address such as `[::1]` (hex digits, `:` and `.` only),
 *   with an optional `:port`. Its brackets are escaped like any other
 *   metacharacter, so `http://[::1]:3000` matches only itself.
 */
const LITERAL_ORIGIN = /^[a-z][a-z0-9.-]*:\/\/(?:[^\s/*+?^${}()|[\]\\]+|\[[0-9a-f:.]+\](?::\d+)?)\/?$/i;

/** Characters that turn an unescaped `.` into part of a quantified wildcard (`.*`, `.+`, `.?`). */
const DOT_QUANTIFIERS = new Set(['*', '+', '?']);

/** A brace quantifier (`{n}`, `{n,}`, `{n,m}`) at the start of the string. */
const BRACE_QUANTIFIER = /^\{\d+(,\d*)?\}/;

/**
 * Whether the character after index `i` in `source` quantifies it: one of
 * {@link DOT_QUANTIFIERS}, or a real brace quantifier. A `{` that does not open
 * a quantifier (e.g. `.{x}`) is a literal brace in a JavaScript regex (no `u`
 * flag), so the `.` before it is still bare.
 */
function isQuantified(source: string, i: number): boolean {
  const next = source[i + 1] ?? '';
  if (DOT_QUANTIFIERS.has(next)) return true;
  return next === '{' && BRACE_QUANTIFIER.test(source.slice(i + 1));
}

/**
 * Whether an `allowedOrigins` entry is a plain origin (matched exactly,
 * case-insensitively) rather than a regex pattern.
 */
function isLiteralOrigin(entry: string): boolean {
  return LITERAL_ORIGIN.test(entry);
}

/**
 * Find the first unescaped `.` in a regex source that is not immediately
 * followed by a quantifier, or `-1` if there is none.
 *
 * Scan rules:
 * - A `\` escapes the next character, inside or outside a character class, so
 *   `\.` is a literal dot and `\\.` is an escaped backslash followed by a
 *   wildcard dot.
 * - Inside a character class (`[...]`) a `.` is already literal, so it is
 *   skipped. In JavaScript regexes (no `v` flag) a `[` inside a class is a
 *   literal and the first unescaped `]` closes it, including in `[]`.
 * - Outside a class, a `.` followed by `*`, `+`, `?` or a brace quantifier
 *   (`{n}`, `{n,}`, `{n,m}`) is an intentional wildcard run (`.*`,
 *   `https://.*\.example\.com`) and is accepted; a bare `.` (including one
 *   before a literal `{`, as in `.{x}`) is almost always a hostname dot that
 *   was meant literally.
 */
function findUnescapedBareDot(source: string): number {
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      i++; // skip the escaped character
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '.' && !isQuantified(source, i)) return i;
  }
  return -1;
}

const ALLOWED_ORIGINS_HINT =
  "Use a plain origin such as 'https://app.example.com' (matched exactly), or escape dots in a regex pattern (e.g. 'https://app\\.example\\.com').";

/**
 * Check one `defaults.allowedOrigins` / `CORS_ALLOWED_ORIGINS` entry.
 *
 * Plain origins (see {@link parseCorsPatterns}) are always valid. A regex entry
 * is rejected when it:
 * - contains a comma — entries are comma-joined into `CORS_ALLOWED_ORIGINS`,
 *   so the runtime would split it into separate entries;
 * - does not compile on its own (`new RegExp(entry)` throws) — this catches
 *   unbalanced groups such as `a)|(?:.*`, which would otherwise close the
 *   `^(?:...)$` wrapper early and change what the anchors apply to;
 * - contains an unescaped `.` that is not followed by a quantifier (see
 *   {@link findUnescapedBareDot}), e.g. `^https://app.example\.com$`.
 *
 * Shared by the runtime ({@link parseCorsPatterns}, which drops invalid entries)
 * and the synth-time check ({@link validateAllowedOrigins}).
 *
 * @param entry - A single, already-trimmed entry
 * @returns An error message, or `undefined` if the entry is valid
 */
export function validateCorsOriginEntry(entry: string): string | undefined {
  const prefix = `defaults.allowedOrigins entry "${entry}"`;
  if (entry.includes(',')) {
    return `${prefix}: contains a comma, but entries are comma-joined into CORS_ALLOWED_ORIGINS. List each origin as its own entry.`;
  }
  if (isLiteralOrigin(entry)) return undefined;
  try {
    new RegExp(entry);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `${prefix}: is not a valid regular expression on its own (${reason}). ${ALLOWED_ORIGINS_HINT}`;
  }
  const dot = findUnescapedBareDot(entry);
  if (dot !== -1) {
    return `${prefix}: has an unescaped '.' at position ${dot}, which matches any character. ${ALLOWED_ORIGINS_HINT}`;
  }
  return undefined;
}

/**
 * Synth-time check for `defaults.allowedOrigins`: throws one `Error` listing
 * every invalid entry (see {@link validateCorsOriginEntry}). Empty and
 * whitespace-only entries are skipped, matching the runtime.
 *
 * Callers pass only resolved strings — CDK tokens are filtered out on the CDK
 * side, and the hosting origins (`CORS_HOSTING_ORIGINS`) are never passed here.
 *
 * @param entries - The `defaults.allowedOrigins` array
 * @throws Error when one or more entries are invalid
 */
export function validateAllowedOrigins(entries: readonly unknown[]): void {
  const problems: string[] = [];
  for (const raw of entries) {
    if (typeof raw !== 'string') {
      problems.push(`defaults.allowedOrigins entry ${JSON.stringify(raw)}: must be a string.`);
      continue;
    }
    const entry = raw.trim();
    if (!entry) continue;
    const problem = validateCorsOriginEntry(entry);
    if (problem) problems.push(problem);
  }
  if (problems.length === 0) return;
  throw new Error(
    problems.length === 1 ? problems[0] : `Invalid defaults.allowedOrigins entries:\n- ${problems.join('\n- ')}`,
  );
}

/**
 * Entries already reported as invalid, so a caller that re-parses the same
 * configuration logs each bad entry once. Capped like {@link warnedOrigins}.
 */
const reportedInvalidEntries = new Set<string>();

function reportInvalidEntryOnce(entry: string, problem: string): void {
  if (reportedInvalidEntries.has(entry)) return;
  if (reportedInvalidEntries.size < WARNED_ORIGINS_LIMIT) reportedInvalidEntries.add(entry);
  console.error(`[CORS] Ignoring ${problem}`);
}

/**
 * Parse a comma-separated CORS origin string into anchored RegExp patterns.
 *
 * Each entry is classified first:
 * - A **plain origin** (`scheme://host[:port]`, optional trailing `/`, no regex
 *   syntax other than `.`) such as `https://app.example.com` is matched
 *   exactly: it is escaped via {@link escapeOriginToPattern}, so its dots are
 *   literal, and compiled with the `i` flag because an origin's scheme and host
 *   are case-insensitive (the same reasoning as the hosting-literal channel in
 *   {@link getCorsPatterns}). A trailing `/` is dropped, since a browser
 *   `Origin` header never carries one.
 * - Anything else is a **regex pattern** and is compiled as `^(?:<entry>)$`:
 *   the `^` and `$` bind the whole expression, so every branch of a top-level
 *   `|` alternation is end-anchored, not just the last. A leading `^` or
 *   trailing `$` inside the entry is redundant and harmless. Regex patterns
 *   keep their own case sensitivity.
 *
 * A regex entry that fails {@link validateCorsOriginEntry} (does not compile on
 * its own, or has an unescaped `.`) is dropped — it never matches — and one
 * `console.error` line is logged for it. The synth-time check
 * ({@link validateAllowedOrigins}) rejects the same entries before deploy.
 *
 * @param raw - Comma-separated CORS entries (e.g. `"https://example.com,^https?://localhost(:\\d+)?$"`)
 * @returns Array of anchored RegExp patterns
 */
export function parseCorsPatterns(raw: string): RegExp[] {
  const patterns: RegExp[] = [];
  for (const entry of splitOrigins(raw)) {
    if (isLiteralOrigin(entry)) {
      patterns.push(new RegExp(escapeOriginToPattern(entry.replace(/\/$/, '')), 'i'));
      continue;
    }
    const problem = validateCorsOriginEntry(entry);
    if (problem) {
      reportInvalidEntryOnce(entry, problem);
      continue;
    }
    patterns.push(new RegExp(`^(?:${entry})$`));
  }
  return patterns;
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
 * the {@link parseCorsPatterns} plain-origin entries (e.g.
 * `https://app.example.com` in `defaults.allowedOrigins`) escape through this
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
 * - `CORS_ALLOWED_ORIGINS` — user-supplied plain origins and regex patterns (set
 *   as an env var on every compute from the stack's `defaults.allowedOrigins`)
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
 * - `CORS_ALLOWED_ORIGINS` is compiled by {@link parseCorsPatterns}: plain
 *   origins match exactly (case-insensitive), other entries are anchored regex
 *   patterns (the `.*` escape hatch and custom regex keep working), and invalid
 *   regex entries are dropped.
 * - `CORS_HOSTING_ORIGINS` holds resolved literal origins; each is escaped by
 *   {@link escapeOriginToPattern} before compiling so a domain like
 *   `d123.cloudfront.net` matches literally (its dots are not wildcards).
 *
 * Returns `null` only when neither env var has a non-empty entry (no allowlist
 * configured, so cross-origin requests are not rejected). When at least one
 * entry is configured but every entry is dropped as invalid, returns `[]`: the
 * allowlist is still in force and matches nothing, so cross-origin requests
 * fail closed (403) rather than falling back to the no-allowlist behavior.
 */
export function getCorsPatterns(): RegExp[] | null {
  if (_corsPatterns !== undefined) return _corsPatterns;

  const envOrigins = process.env.CORS_ALLOWED_ORIGINS ?? '';
  const hostingOrigins = process.env.CORS_HOSTING_ORIGINS ?? '';

  // User channel: plain origins (exact, case-insensitive) and anchored regex
  // patterns; invalid regex entries are dropped (see parseCorsPatterns).
  const regexPatterns = envOrigins ? parseCorsPatterns(envOrigins) : [];
  // Literal channel: framework-injected resolved origins, escaped so regex
  // metacharacters (notably dots) match literally rather than as wildcards.
  // Case-INSENSITIVE (`i`): an Origin's scheme and host are case-insensitive per
  // the URL spec, and some AWS hostnames are case-preserving but resolved
  // case-insensitively — notably an Application Load Balancer's DNS name
  // (`blocks-Hosti-AbCd….elb.amazonaws.com`), which the browser lowercases in
  // the `Origin` header. A case-sensitive match would then reject the very
  // origin the deploy configured. The user's `CORS_ALLOWED_ORIGINS` regex
  // patterns keep their own case sensitivity (its plain origins are also `i`).
  const hostingPatterns = splitOrigins(hostingOrigins)
    .map(origin => new RegExp(escapeOriginToPattern(origin), 'i'));

  const all = [...regexPatterns, ...hostingPatterns];
  // An allowlist is configured whenever either channel has a non-empty entry,
  // even if every entry was dropped as invalid: `[]` (match nothing) keeps the
  // dispatch-level rejection active, whereas `null` would disable it.
  const configured = splitOrigins(envOrigins).length > 0 || hostingPatterns.length > 0;
  _corsPatterns = configured ? all : null;
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
  // Preset-agnostic on purpose: this fires mostly on sandbox stacks, so an
  // example tied to one preset would swap the app's other defaults (or, copied
  // into production, carry the sandbox localhost pattern there).
  // A plain origin is matched exactly, so the example needs no regex escaping.
  const example = "defaults: { ...yourPreset, allowedOrigins: [...yourPreset.allowedOrigins, 'https://myapp.com'] }";
  console.warn(
    `[CORS] Origin "${origin}" is not allowed. Add it to the stack's defaults.allowedOrigins (plain origins or regex patterns), keeping the preset's existing entries. Example: ${example}`
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
 * Reset the lazy CORS pattern cache, the warned-origin set and the
 * reported-invalid-entry set. **For testing only.**
 */
export function _resetCorsPatterns(): void {
  _corsPatterns = undefined;
  warnedOrigins.clear();
  reportedInvalidEntries.clear();
}
