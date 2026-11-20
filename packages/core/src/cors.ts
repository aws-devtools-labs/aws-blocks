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
 * The `scheme://` prefix of a plain origin: a letter, then letters, digits, `-`
 * or `.`. (The URL spec also allows `+` in a scheme, but `+` is a regex
 * quantifier, so an entry using it is read as a regex pattern.)
 */
const ORIGIN_SCHEME = /^([a-z][a-z0-9.-]*):\/\//i;

/**
 * The hostname of a parsed `http`/`https` plain origin (`URL.hostname`, already
 * lowercased and in punycode): letters, digits, `.` and `-`, or a bracketed
 * IPv6 address. Anything else (e.g. the `;x` in `https://a.com;x`) is not a
 * host a browser would send in an `Origin` header.
 */
const URL_HOSTNAME = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])$/i;

/**
 * A bracketed IPv6 host such as `[::1]` (hex digits, `:` and `.` only) at the
 * start of an origin's authority. Its brackets are escaped like any other
 * metacharacter when matched, so `http://[::1]:3000` matches only itself.
 */
const IPV6_HOST = /^\[[0-9a-f:.]+\]/i;

/**
 * Regex metacharacters other than `.` (plus whitespace). An entry whose
 * authority contains none of these — once a leading bracketed IPv6 host is set
 * aside — is a plain origin, not a regex pattern: `* + ? ^ $ { } ( ) | [ ] \`.
 */
const REGEX_SYNTAX = /[\s*+?^${}()|[\]\\]/;

/**
 * The strict shape of a plain origin with a non-special scheme (e.g.
 * `chrome-extension://abcdef`), which the WHATWG `URL` parser does not reduce to
 * a `scheme://host[:port]` origin (its `origin` is `"null"`): a name of
 * letters, digits, `.`, `_` and `-`, or a bracketed IPv6 address, then an
 * optional numeric `:port` and an optional trailing `/`.
 */
const NON_SPECIAL_ORIGIN = /^[a-z][a-z0-9.-]*:\/\/(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])(?::\d+)?\/?$/i;

/** Schemes whose plain origins are canonicalized through the WHATWG `URL` parser. */
const URL_ORIGIN_SCHEMES = new Set(['http', 'https']);

/** Characters that turn an unescaped `.` into part of a quantified wildcard (`.*`, `.+`, `.?`). */
const DOT_QUANTIFIERS = new Set(['*', '+', '?']);

/**
 * A brace quantifier at the start of the string: `{n}` only. `{n,}` and
 * `{n,m}` cannot appear in an entry because entries are comma-joined into
 * `CORS_ALLOWED_ORIGINS` (see {@link validateCorsOriginEntry}), so they are not
 * recognized here either.
 */
const BRACE_QUANTIFIER = /^\{\d+\}/;

/**
 * Single-character quantifiers that repeat their operand, for the
 * nested-quantifier check ({@link findNestedQuantifier}): `*` and `+`. A brace
 * quantifier (`{n}`) also counts as repeating, but is matched separately via
 * {@link BRACE_QUANTIFIER} in {@link isRepeatQuantifierAt}. `?` (zero or one)
 * is not counted.
 */
const REPEAT_QUANTIFIERS = new Set(['*', '+']);

/**
 * Whether the character after index `i` in `source` quantifies it: one of
 * {@link DOT_QUANTIFIERS}, or a real brace quantifier (`{n}`). A `{` that does
 * not open a quantifier (e.g. `.{x}`) is a literal brace in a JavaScript regex
 * (no `u` flag), so the `.` before it is still bare.
 */
function isQuantified(source: string, i: number): boolean {
  const next = source[i + 1] ?? '';
  if (DOT_QUANTIFIERS.has(next)) return true;
  return next === '{' && BRACE_QUANTIFIER.test(source.slice(i + 1));
}

/**
 * Whether the character at index `i` in `source` starts a repeating quantifier
 * (see {@link REPEAT_QUANTIFIERS}) or a brace quantifier (`{n}`).
 */
function isRepeatQuantifierAt(source: string, i: number): boolean {
  const ch = source[i] ?? '';
  if (REPEAT_QUANTIFIERS.has(ch)) return true;
  return ch === '{' && BRACE_QUANTIFIER.test(source.slice(i));
}

/**
 * Whether an `allowedOrigins` entry is a plain origin (matched exactly,
 * case-insensitively) rather than a regex pattern: `scheme://` followed by an
 * authority (and possibly more) with no regex syntax other than `.`, where a
 * leading bracketed IPv6 host is allowed. Whether a plain origin is also a
 * *valid* origin is checked by {@link validatePlainOrigin}.
 */
function isLiteralOrigin(entry: string): boolean {
  const scheme = ORIGIN_SCHEME.exec(entry);
  if (!scheme) return false;
  const rest = entry.slice(scheme[0].length).replace(IPV6_HOST, '');
  return !REGEX_SYNTAX.test(rest);
}

/**
 * The origin a browser would send for a plain-origin entry, used for matching.
 *
 * For `http`/`https` entries this is `new URL(entry).origin`, which lowercases
 * the scheme and host, converts an internationalized host to its punycode form
 * (`https://bücher.example` → `https://xn--bcher-kva.example`) and drops the
 * scheme's default port (`https://app.example.com:443` →
 * `https://app.example.com`) — the same serialization a browser uses for the
 * `Origin` header. Other schemes (e.g. `chrome-extension://…`) have no such
 * serialization (`URL.origin` is `"null"`), so they are kept as written, minus
 * a trailing `/`. An entry the parser rejects is also kept as written; callers
 * validate entries first (see {@link validatePlainOrigin}).
 */
function canonicalOrigin(origin: string): string {
  const asWritten = origin.replace(/\/$/, '');
  const scheme = ORIGIN_SCHEME.exec(origin)?.[1]?.toLowerCase();
  if (!scheme || !URL_ORIGIN_SCHEMES.has(scheme)) return asWritten;
  try {
    const serialized = new URL(origin).origin;
    return serialized === 'null' ? asWritten : serialized;
  } catch {
    return asWritten;
  }
}

/**
 * Compile a literal origin into an anchored, case-insensitive RegExp that
 * matches only that origin, after canonicalizing it (see
 * {@link canonicalOrigin}). Shared by the plain-origin entries of
 * {@link parseCorsPatterns} and the hosting-literal channel of
 * {@link getCorsPatterns}, so both match the browser-serialized origin.
 *
 * The value is canonicalized only when it is a valid plain origin
 * ({@link isLiteralOrigin} and {@link validatePlainOrigin}); otherwise it is
 * escaped as written, so it fails closed. User entries are validated before
 * they get here, but hosting origins are not: without this check a malformed
 * value such as `https://user@evil.com/x` would canonicalize to
 * `https://evil.com` and match that origin.
 *
 * Case-insensitive (`i`) because an origin's scheme and host are
 * case-insensitive per the URL spec.
 *
 * @param origin - A literal origin (not a regex pattern)
 */
function literalOriginPattern(origin: string): RegExp {
  const valid = isLiteralOrigin(origin) && validatePlainOrigin(origin) === undefined;
  return new RegExp(escapeOriginToPattern(valid ? canonicalOrigin(origin) : origin), 'i');
}

/**
 * Check a plain-origin entry (see {@link isLiteralOrigin}).
 *
 * - `http`/`https` entries must parse with the WHATWG `URL` parser (so a
 *   malformed or non-numeric port is rejected) and must not carry user info
 *   (`user@`), a path other than a single trailing `/`, a query or a fragment
 *   (`#`) — none of which are part of an origin, so such an entry could never
 *   match. The path is checked on the raw string, because the parser
 *   normalizes paths such as `/.` and `/%2e` to `/`. The parsed hostname must
 *   also match {@link URL_HOSTNAME}.
 * - Other schemes must match {@link NON_SPECIAL_ORIGIN}.
 *
 * @returns A short reason, or `undefined` if the entry is a valid origin
 */
function validatePlainOrigin(entry: string): string | undefined {
  const scheme = (ORIGIN_SCHEME.exec(entry)?.[1] ?? '').toLowerCase();
  if (!URL_ORIGIN_SCHEMES.has(scheme)) {
    return NON_SPECIAL_ORIGIN.test(entry) ? undefined : 'is not an origin of the form scheme://host[:port]';
  }
  const afterScheme = entry.slice(scheme.length + 3);
  const authority = afterScheme.split(/[/?#]/)[0];
  // Everything between the authority and any query or fragment, as written.
  const rawPath = afterScheme.slice(authority.length).split(/[?#]/)[0];
  if (!authority) return 'has no host';
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return 'is not a valid origin (the host or port cannot be parsed)';
  }
  if (url.username || url.password || authority.includes('@')) return "must not include user info ('user@')";
  if (url.hash || entry.includes('#')) return "must not include a fragment ('#')";
  if (url.search) return 'must not include a query';
  if ((rawPath && rawPath !== '/') || url.pathname !== '/') return 'must not include a path';
  if (!URL_HOSTNAME.test(url.hostname)) return 'has a host that is not a valid hostname';
  return undefined;
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
 *   (`{n}` only — see {@link BRACE_QUANTIFIER}) is an intentional wildcard run
 *   (`.*`, `https://[a-z0-9-]+\.example\.com`) and is accepted; a bare `.`
 *   (including one before a literal `{`, as in `.{x}`) is almost always a
 *   hostname dot that was meant literally.
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

/**
 * Find the first repeating quantifier (`*`, `+` or `{n}`) applied to a group
 * whose body already contains one, such as `(a+)+` or `(.*)*`, or contains an
 * unescaped `|` alternation (at any depth), such as `(a|a)+`. Returns the index
 * of the outer quantifier, or `-1` if there is none.
 *
 * This rejects two common shapes of patterns whose matching time can grow
 * very quickly with the input length; it does not rule out every slow pattern.
 *
 * Uses the same escape and character-class rules as
 * {@link findUnescapedBareDot}, and additionally tracks group depth. The
 * `?`, `?:`, `?=`, `?!`, `?<=`, `?<!` and `?<name>` that follow a `(` are group
 * syntax, not quantifiers. A `?` quantifier is not counted on either side.
 * Must only be called on a source that compiles (so groups are balanced).
 */
function findNestedQuantifier(source: string): number {
  // One frame per open group (index 0 is the whole pattern): whether its body
  // contains a repeating quantifier, and whether it contains an alternation,
  // so far.
  const frames: Array<{ repeats: boolean; alternates: boolean }> = [{ repeats: false, alternates: false }];
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
    if (ch === '(') {
      frames.push({ repeats: false, alternates: false });
      if (source[i + 1] === '?') {
        // Skip the group-type prefix so its `?` is not read as a quantifier.
        if (source[i + 2] === '<' && source[i + 3] !== '=' && source[i + 3] !== '!') {
          const close = source.indexOf('>', i + 3);
          i = close === -1 ? i + 2 : close;
        } else {
          i += source[i + 2] === '<' ? 3 : 2;
        }
      }
      continue;
    }
    if (ch === ')') {
      const body = frames.pop() ?? { repeats: false, alternates: false };
      const parent = frames[frames.length - 1];
      const quantified = isRepeatQuantifierAt(source, i + 1);
      if (quantified && (body.repeats || body.alternates)) return i + 1;
      if (quantified || body.repeats) parent.repeats = true;
      // An alternation nested in an unrepeated group is still inside any
      // repeated group further out, e.g. `((a|a))+`.
      if (body.alternates) parent.alternates = true;
      continue;
    }
    if (ch === '|') {
      frames[frames.length - 1].alternates = true;
      continue;
    }
    if (isRepeatQuantifierAt(source, i)) frames[frames.length - 1].repeats = true;
  }
  return -1;
}

/**
 * Whether an entry is written as a glob (`https://*.example.com`) rather than a
 * regex: it starts with `*`, or has a `*` directly after an unescaped `/`. In a
 * regex that `*` repeats the `/` before it, so the entry would never match a
 * subdomain — escaping its dots (`https://*\.example\.com`) does not help.
 */
function looksLikeGlob(entry: string): boolean {
  return entry.startsWith('*') || /(?:^|[^\\])\/\*/.test(entry);
}

const ALLOWED_ORIGINS_HINT =
  "Use a plain origin such as 'https://app.example.com' (matched exactly), or escape dots in a regex pattern (e.g. 'https://app\\.example\\.com').";

/** Suggested regex for "any subdomain of", shared by the glob message and the docs. */
const SUBDOMAIN_PATTERN_EXAMPLE = "'https://[a-z0-9-]+\\.example\\.com'";

/**
 * Check one `defaults.allowedOrigins` / `CORS_ALLOWED_ORIGINS` entry.
 *
 * Every entry is rejected when it contains a comma — entries are comma-joined
 * into `CORS_ALLOWED_ORIGINS`, so the runtime would split it into separate
 * entries (this is also why brace quantifiers are limited to `{n}`).
 *
 * A plain origin (see {@link parseCorsPatterns}) is rejected when it is not a
 * valid origin (see {@link validatePlainOrigin}): an unparseable host or port,
 * or user info, a path, a query or a fragment.
 *
 * A regex entry is rejected when it:
 * - is written as a glob, such as `https://*.example.com` (see
 *   {@link looksLikeGlob}) — wildcards are not supported;
 * - does not compile on its own (`new RegExp(entry)` throws) — this catches
 *   unbalanced groups such as `a)|(?:.*`, which would otherwise close the
 *   `^(?:...)$` wrapper early and change what the anchors apply to;
 * - repeats (`*`, `+` or `{n}`) a group that already contains a repeating
 *   quantifier, such as `(a+)+`, or an alternation, such as `(a|a)+` (see
 *   {@link findNestedQuantifier}) — such patterns can make matching very slow
 *   on some `Origin` values (this check does not rule out every slow pattern);
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
    return `${prefix}: contains a comma, but entries are comma-joined into CORS_ALLOWED_ORIGINS. List each origin as its own entry (brace quantifiers are limited to {n} for the same reason).`;
  }
  if (isLiteralOrigin(entry)) {
    const problem = validatePlainOrigin(entry);
    return problem ? `${prefix}: ${problem}. ${ALLOWED_ORIGINS_HINT}` : undefined;
  }
  if (looksLikeGlob(entry)) {
    return `${prefix}: wildcards are not supported; use a regex such as ${SUBDOMAIN_PATTERN_EXAMPLE} to match any subdomain.`;
  }
  try {
    new RegExp(entry);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `${prefix}: is not a valid regular expression on its own (${reason}). ${ALLOWED_ORIGINS_HINT}`;
  }
  const nested = findNestedQuantifier(entry);
  if (nested !== -1) {
    return `${prefix}: has a nested quantifier at position ${nested} (a group repeated with '*', '+' or '{n}' that itself contains '*', '+', '{n}' or an alternation '|'). Nested quantifiers and alternation inside a repeated group are not supported, because they can make matching very slow. Repeat the inner part only, e.g. '[a-z0-9-]+' instead of '([a-z0-9-]+)+'; for subdomains at any depth use 'https://[a-z0-9.-]+\\.example\\.com' instead of '([a-z0-9-]+\\.)*'.`;
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
 *   exactly via {@link literalOriginPattern}: it is canonicalized to the origin
 *   a browser sends (for `http`/`https`: lowercased, punycode host, default port
 *   dropped — see {@link canonicalOrigin}), escaped via
 *   {@link escapeOriginToPattern}, so its dots are literal, and compiled with
 *   the `i` flag because an origin's scheme and host are case-insensitive (the
 *   same reasoning as the hosting-literal channel in {@link getCorsPatterns}).
 *   A trailing `/` is dropped, since a browser `Origin` header never carries
 *   one.
 * - Anything else is a **regex pattern** and is compiled as `^(?:<entry>)$`:
 *   the `^` and `$` bind the whole expression, so every branch of a top-level
 *   `|` alternation is end-anchored, not just the last. A leading `^` or
 *   trailing `$` inside the entry is redundant and harmless. Regex patterns
 *   keep their own case sensitivity.
 *
 * An entry that fails {@link validateCorsOriginEntry} (a plain origin that is
 * not a valid origin; a regex that is a glob, does not compile on its own, has
 * a nested quantifier or an alternation inside a repeated group, or has an
 * unescaped `.`) is dropped — it never matches — and one
 * `console.error` line is logged for it. The synth-time check
 * ({@link validateAllowedOrigins}) rejects the same entries before deploy.
 *
 * @param raw - Comma-separated CORS entries (e.g. `"https://example.com,^https?://localhost(:\\d+)?$"`)
 * @returns Array of anchored RegExp patterns
 */
export function parseCorsPatterns(raw: string): RegExp[] {
  const patterns: RegExp[] = [];
  for (const entry of splitOrigins(raw)) {
    const problem = validateCorsOriginEntry(entry);
    if (problem) {
      reportInvalidEntryOnce(entry, problem);
      continue;
    }
    if (isLiteralOrigin(entry)) {
      patterns.push(literalOriginPattern(entry));
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
 * helper (single source of truth), via {@link literalOriginPattern}. The
 * `export` keyword is kept only so unit tests can import it — `cors.ts` is
 * not in any package export map, so this is not a public API.
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
 * - `CORS_HOSTING_ORIGINS` holds resolved literal origins; each is compiled by
 *   {@link literalOriginPattern} (canonicalized, then escaped by
 *   {@link escapeOriginToPattern}) so a domain like `d123.cloudfront.net`
 *   matches literally (its dots are not wildcards).
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
  // Canonicalized like a plain user entry (see literalOriginPattern).
  const hostingPatterns = splitOrigins(hostingOrigins).map(literalOriginPattern);

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
