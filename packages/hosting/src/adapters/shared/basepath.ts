/**
 * Pure helpers for `manifest.basePath` — the cross-framework URL prefix
 * that maps to Next.js `basePath`, Astro `base`, Nuxt `app.baseURL`.
 *
 * Both functions do plain string manipulation of glob-style patterns; no
 * URL parsing, no framework-specific knowledge. Adapter code calls
 * `normalizeBasePath` on the user's raw config value, then the L3 calls
 * `prependBasePath` on every emitted CloudFront behavior pattern.
 */

/**
 * Normalize a user-supplied base path.
 *
 * - `'/app/'` → `'/app'` (drop trailing slash)
 * - `'/'` → `undefined` (root is the default; don't carry a no-op prefix)
 * - `''` → `undefined`
 * - `undefined` → `undefined`
 * - `'app'` → `'/app'` (add leading slash)
 *
 * Returns `undefined` when the framework isn't using a base path, which
 * keeps the `manifest.basePath` field omitted in the common case.
 */
export const normalizeBasePath = (
  raw: string | undefined,
): string | undefined => {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '/') return undefined;
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading;
};

/**
 * Prepend `basePath` to a URL pattern.
 *
 * Examples (basePath = `/app`):
 * - `('/foo/*')` → `'/app/foo/*'`
 * - `('/')` → `'/app/'`
 * - `('foo')` → `'/app/foo'`
 *
 * When `basePath` is `undefined`, the pattern is returned unchanged.
 *
 * IDEMPOTENT: a pattern that is ALREADY under `basePath` (equals it, or starts
 * with `basePath + '/'`) is returned unchanged rather than prefixed a second
 * time. The contract is that adapters emit basePath-RELATIVE patterns and the
 * L3 prefixes once — but Next.js bakes its `basePath` into the OpenNext output
 * and `routes-manifest.json` (route patterns AND redirect/header sources), so
 * those arrive pre-prefixed. Without this guard they double-prefix to
 * `/app/app/...`, which matches nothing in the route table → every asset routes
 * to the SSR Lambda → 404. The `+ '/'` boundary keeps a coincidental relative
 * pattern like `/application/*` (basePath `/app`) from being treated as already
 * prefixed. This guard is the cross-adapter safety net; the Next adapter ALSO
 * strips the baked-in prefix up front (defense in depth).
 *
 * SLASH-NORMALIZED: the result never contains a `//`. OpenNext can emit patterns
 * that join basePath without collapsing the separator (`app//edge`), and a `//`
 * in a CloudFront path pattern / KVS route matches the literal `//` URL, never
 * the browser's single-slash request → the route misses → 500. Collapsing here
 * backstops any caller that didn't normalize first (the Next adapter's
 * `nextPatternToCloudFront` also collapses at the source).
 */
export const prependBasePath = (
  basePath: string | undefined,
  pattern: string,
): string => {
  if (!basePath) return collapseSlashes(pattern);
  if (pattern === '' || pattern === '/') return `${basePath}/`;
  // Already under basePath? Leave it (idempotent — see doc above).
  if (pattern === basePath || pattern.startsWith(`${basePath}/`)) {
    return collapseSlashes(pattern);
  }
  const withLeading = pattern.startsWith('/') ? pattern : `/${pattern}`;
  return collapseSlashes(`${basePath}${withLeading}`);
};

/**
 * Collapse runs of `/` to a single `/`. URL paths never legitimately contain
 * `//`, so this is always safe for the glob-style patterns these helpers
 * manipulate. (Does not touch a leading `//` in a scheme-relative URL — these
 * are path patterns, not URLs.)
 */
const collapseSlashes = (pattern: string): string =>
  pattern.replace(/\/{2,}/g, '/');
