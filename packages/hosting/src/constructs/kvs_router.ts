/**
 * KVS edge router (Tier 3 — the SST model).
 *
 * Replaces per-route CloudFront cache behaviors with ONE default behavior whose
 * viewer-request CloudFront Function reads a route table from a KeyValueStore
 * (KVS) and routes each request to the right origin via
 * `cf.selectRequestOriginById()`. Eliminates the 75-behaviors-per-distribution
 * limit (route table is data, not infrastructure).
 *
 * This module has two halves:
 *   1. {@link buildKvsEntries} — pure function: manifest → KVS key/value map
 *      (the route table, redirects, per-pattern headers, and a metadata blob).
 *      Testable without CDK or a live edge.
 *   2. {@link generateKvsRouterRequestCode} / {@link generateKvsRouterResponseCode}
 *      — the CloudFront Function source (JS 2.0). Build-INDEPENDENT: buildId
 *      and routes live in KVS, so the same function ships every deploy and the
 *      atomic cutover is purely the gated KVS update.
 *
 * KVS limits respected: key ≤512 B, value ≤1 KB, store ≤5 MB. The route /
 * redirect / header tables are packed into ≤1 KB JSON chunks; the metadata
 * blob records the chunk counts so the function reads a known, small number of
 * keys per request.
 */
import type { DeployManifest } from '../manifest/types.js';
import { HostingError } from '../hosting_error.js';
import { buildCapabilityPlan } from '../plan/capability-plan.js';
import { toTerseRows } from '../plan/route-table.js';
import type { CapabilityPlan } from '../plan/types.js';

// The pure routing helpers moved to the service-agnostic plan layer (so every
// front-door adapter shares one implementation). Re-export them here for
// back-compat with existing imports/tests that reference them from this module
// (e.g. cdn_construct's edge-behavior ordering, the coalesceRoutes unit tests).
export { coalesceRoutes, routeSpecificity } from '../plan/route-table.js';

/** Stable origin ids the router selects between (set on the distribution). */
export const ORIGIN_ID = {
  s3: 'blocks-s3',
  server: 'blocks-server',
  image: 'blocks-image',
} as const;

/** Route kind markers stored in the KVS route table (kept terse for size). */
type RouteKind = 's' | 'c' | 'i'; // static(S3) | compute(server) | image

/** Max bytes per KVS value (AWS hard limit is 1 KB; stay safely under). */
const MAX_VALUE_BYTES = 900;

type BuildKvsInput = {
  manifest: DeployManifest;
  buildId: string;
  /** Whether the deploy has a server (compute) origin. */
  hasServer: boolean;
  /** Whether an image-optimization origin exists. */
  hasImage: boolean;
  /** Apex/www canonical-redirect mode (from the Hosting `domain` config). */
  wwwRedirect?: 'toApex' | 'toWww' | 'none';
  /**
   * Whether skew protection is enabled. When false the router must NOT honor a
   * `__dpl` build-pin cookie (a leftover cookie from a previously-enabled
   * deploy would otherwise pin a visitor to a now-deleted build → 403).
   */
  skewEnabled?: boolean;
  /**
   * Compute names that are Lambda@Edge route functions (OpenNext `runtime:
   * 'edge'` split bundles, e.g. `edge1`/`edge2`). Routes targeting these are
   * served by a DEDICATED CloudFront cache behavior with the edge function
   * attached (origin-request), which takes precedence over the single default
   * behavior — so they must be EXCLUDED from the KVS route table. Otherwise the
   * router would classify them as compute and send them to the default server
   * Lambda, which does NOT contain the split edge routes → 500.
   */
  edgeTargets?: Set<string>;
  /**
   * Override the max chunks allowed per KVS table (routes/redirects/headers).
   * Defaults to {@link KVS_BUDGET.maxChunksPerTable} (64). Sourced from the
   * `quotas.maxRouteChunks` hosting prop so a very large (e.g.
   * `trailingSlash: true`) site can raise the build-time guard after verifying
   * edge-function headroom. See issue #8.
   */
  maxChunksPerTable?: number;
};

/**
 * Safe per-request read / store-size budget for the edge router. The old
 * per-behavior model failed synth with a clear `TooManyRoutesError` at 75
 * behaviors; collapsing to KVS removed that ceiling but the AWS limits did not
 * disappear — they moved to runtime (KVS store ≤5 MB; CloudFront Functions have
 * a compute-utilization cap, and the router reads chunks sequentially per
 * request). These budgets re-introduce a build-time guard so an oversized route
 * table fails at synth with an actionable error instead of silently 5xx-ing at
 * the edge or failing the KVS write at deploy.
 */
const KVS_BUDGET = {
  /** Hard store ceiling is 5 MB; stay well under to leave headroom. */
  maxStoreBytes: 4.5 * 1024 * 1024,
  /**
   * Max chunks of any one table. The request fn reads meta + (worst case) every
   * route chunk + every redirect chunk per request; the response fn reads every
   * header chunk. 64 chunks (~25 rows each ≈ 1600 rows) is far above the old
   * 75-behavior cap while keeping sequential reads bounded.
   */
  maxChunksPerTable: 64,
} as const;

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Pack an array of small JSON-serializable rows into ≤MAX_VALUE_BYTES chunks.
 * Returns the chunk values (each a JSON array string).
 */
const chunkRows = (rows: unknown[]): string[] => {
  const chunks: string[] = [];
  let cur: unknown[] = [];
  for (const row of rows) {
    const candidate = JSON.stringify([...cur, row]);
    if (cur.length > 0 && byteLen(candidate) > MAX_VALUE_BYTES) {
      chunks.push(JSON.stringify(cur));
      cur = [row];
    } else {
      cur.push(row);
    }
  }
  if (cur.length > 0) chunks.push(JSON.stringify(cur));
  return chunks;
};

/**
 * Render the KVS key/value map for a deploy from a service-agnostic
 * {@link CapabilityPlan}. This is the CloudFront RENDERER: it takes the neutral
 * plan (origins + route table + policies + release) the core produced and
 * projects it onto CloudFront's KeyValueStore encoding. Keys:
 *   - `meta`  : metadata blob (buildId, basePath, spaFallback, image prefix,
 *               origin ids, chunk counts).
 *   - `r{n}`  : route-table chunks — JSON `[[pattern, kind], ...]`.
 *   - `d{n}`  : redirect chunks    — JSON `[[source, dest, status], ...]`.
 *   - `h{n}`  : header chunks      — JSON `[[pattern, {name:value}], ...]`.
 *
 * @param opts.maxChunksPerTable Override the per-table chunk budget (a
 *   CloudFront-specific concern sourced from the `quotas.maxRouteChunks` prop),
 *   NOT part of the neutral plan.
 */
export const renderKvsEntries = (
  plan: CapabilityPlan,
  opts: { maxChunksPerTable?: number } = {},
): Record<string, string> => {
  const { policies, routes, release } = plan;

  // Render the neutral route table into the terse `[pattern, code]` rows the KVS
  // chunker packs (`static→'s'`, `server→'c'`, `image→'i'`). Classification,
  // coalescing, basePath-prefixing, and ordering already happened in the plan
  // layer (shared by every front-door adapter); redirects/headers arrive
  // basePath-resolved.
  const coalesced: [string, RouteKind][] = toTerseRows(routes.entries);

  const redirectRows: [string, string, number][] = routes.redirects.map(
    (r): [string, string, number] => [r.source, r.destination, r.statusCode],
  );

  const headerRows: [string, Record<string, string>][] = routes.headers.map(
    (h): [string, Record<string, string>] => [h.pattern, h.headers],
  );

  const routeChunks = chunkRows(coalesced);
  const redirectChunks = chunkRows(redirectRows);
  const headerChunks = chunkRows(headerRows);

  const meta = {
    b: release.buildId,
    bp: policies.basePath ?? '',
    spa: policies.spaFallback ? 1 : 0,
    img: policies.imagePrefix ?? '',
    srv: policies.hasServer ? 1 : 0,
    // assetPrefix (Next.js): the router strips this prefix from a static URI
    // before the build-id rewrite so prefixed asset URLs resolve to the same
    // S3 objects as unprefixed ones. Empty string = no prefix.
    aP: policies.assetPrefix ?? '',
    // www↔apex canonical redirect mode ('' = none).
    ww:
      policies.wwwRedirect && policies.wwwRedirect !== 'none'
        ? policies.wwwRedirect
        : '',
    // skew protection on? When 0 the router ignores any `__dpl` build-pin
    // cookie (a stale cookie from a previously-enabled deploy must not pin a
    // visitor to a now-deleted build).
    sk: policies.skewEnabled ? 1 : 0,
    oS3: ORIGIN_ID.s3,
    oSrv: ORIGIN_ID.server,
    oImg: ORIGIN_ID.image,
    rc: routeChunks.length,
    dc: redirectChunks.length,
    hc: headerChunks.length,
  };
  const metaJson = JSON.stringify(meta);
  if (byteLen(metaJson) > 1024) {
    throw new HostingError('KvsMetadataTooLargeError', {
      message: `KVS metadata blob is ${byteLen(metaJson)} bytes, exceeding the 1 KB per-value limit.`,
      resolution:
        'This is unexpected — basePath/imagePrefix are unusually long. File an issue.',
    });
  }

  // ---- build-time budget guard (replaces the old TooManyRoutesError) ----
  // Fail synth with an actionable error if the route/redirect/header tables
  // would exceed a safe KVS store size or per-request read budget, rather than
  // letting it surface as a deploy-time KVS write failure or an edge 5xx.
  const tooManyChunks = Math.max(
    routeChunks.length,
    redirectChunks.length,
    headerChunks.length,
  );
  // Tunable via `quotas.maxRouteChunks` (see issue #8); defaults to 64. Must be
  // a positive integer — a fractional value (e.g. 0.5) is a caller mistake and
  // falls back to the default rather than silently capping between chunk counts.
  const maxChunksPerTable =
    Number.isInteger(opts.maxChunksPerTable) &&
    (opts.maxChunksPerTable ?? 0) > 0
      ? opts.maxChunksPerTable!
      : KVS_BUDGET.maxChunksPerTable;
  if (tooManyChunks > maxChunksPerTable) {
    // Identify which table hit the cap for a targeted error message.
    const culprit =
      redirectChunks.length === tooManyChunks
        ? 'redirects'
        : routeChunks.length === tooManyChunks
          ? 'routes'
          : 'headers';
    throw new HostingError('TooManyRoutesError', {
      message:
        `Edge route table needs ${tooManyChunks} chunks for the ${culprit} table, ` +
        `exceeding the safe per-request read budget of ${maxChunksPerTable}. ` +
        `(Each chunk holds ~25 entries, so the cap is roughly ${maxChunksPerTable * 25} entries.)`,
      resolution:
        (culprit === 'redirects'
          ? 'The most common cause is a `trailingSlash: true` Next.js config ' +
            '— it emits one canonical-form redirect per route, which doubles ' +
            'the redirect count. Consider switching to `trailingSlash: false` ' +
            '(the default), reducing the number of routes, or consolidating ' +
            'redirects into wildcard patterns. '
          : 'Reduce the number of routes/redirects/headers, or consolidate ' +
            'them into wildcard patterns. ') +
        'The KVS edge router reads chunks sequentially per request, so an ' +
        'unbounded table risks the CloudFront Function compute-utilization ' +
        'limit at the edge. If you have measured headroom, raise the ' +
        '`quotas.maxRouteChunks` hosting prop.',
    });
  }

  // Insertion order matters for atomicity: `meta` (which carries the active
  // buildId + chunk counts) MUST be the last key written. The KvKeys handler
  // batches UpdateKeys in ≤50-key groups; if `meta` landed in an early batch a
  // concurrent request could read the new buildId/chunk-counts against
  // still-stale r*/d*/h* chunks mid-deploy. Writing meta last means readers see
  // a coherent (old) view until every data chunk is in place, then flip.
  const entries: Record<string, string> = {};
  routeChunks.forEach((c, i) => {
    entries[`r${i}`] = c;
  });
  redirectChunks.forEach((c, i) => {
    entries[`d${i}`] = c;
  });
  headerChunks.forEach((c, i) => {
    entries[`h${i}`] = c;
  });
  entries.meta = metaJson; // written last — see note above

  const totalBytes = Object.entries(entries).reduce(
    (sum, [k, v]) => sum + byteLen(k) + byteLen(v),
    0,
  );
  if (totalBytes > KVS_BUDGET.maxStoreBytes) {
    throw new HostingError('RouteTableTooLargeError', {
      message: `Edge route table is ${(totalBytes / 1024 / 1024).toFixed(2)} MB, exceeding the safe KVS store budget of ${(KVS_BUDGET.maxStoreBytes / 1024 / 1024).toFixed(2)} MB.`,
      resolution:
        'Reduce the number of routes/redirects/headers. The CloudFront ' +
        'KeyValueStore hard limit is 5 MB total.',
    });
  }
  return entries;
};

/**
 * Build the KVS key/value map directly from a manifest (+ deploy flags).
 *
 * Thin wrapper over the service-agnostic core: it builds a {@link CapabilityPlan}
 * and renders it with {@link renderKvsEntries}. Retained as the historical entry
 * point so existing callers/tests are unchanged; new CloudFront code builds the
 * plan explicitly and calls `renderKvsEntries` (so the plan is the single source
 * of routing truth every front-door adapter shares).
 */
export const buildKvsEntries = (input: BuildKvsInput): Record<string, string> =>
  renderKvsEntries(
    buildCapabilityPlan({
      manifest: input.manifest,
      buildId: input.buildId,
      hasServer: input.hasServer,
      hasImage: input.hasImage,
      wwwRedirect: input.wwwRedirect,
      skewEnabled: input.skewEnabled,
      edgeTargets: input.edgeTargets,
    }),
    { maxChunksPerTable: input.maxChunksPerTable },
  );

/**
 * Shared CloudFront-Function helper source, concatenated VERBATIM into BOTH the
 * viewer-request and viewer-response function bodies so there is ONE definition
 * of the KVS reader + the pattern matcher (Finding 7: these used to be copied
 * into each function and `matchPattern` had already diverged — request returned
 * `{tail}` while response returned a boolean — so a fix to one silently desynced
 * the other; Findings 2/3 touched exactly this matcher).
 *
 * Unified on the OBJECT-returning form: `matchPattern` returns `{tail}` on a
 * match else `null`. The request fn reads `.tail` (for wildcard-redirect tail
 * splicing); the response fn only needs a yes/no, and `if (matchPattern(...))`
 * is truthy for the object / falsy for `null`, so the same function serves both.
 *
 * `stripBasePath` is the SINGLE basePath-strip used by every strip site
 * (Finding 8: the strip was reimplemented inline with INCONSISTENT guards — the
 * canonical 308 used `=== bp || startsWith(bp + '/')` but the image/static
 * strips used a bare `indexOf(bp) === 0`, so a false-prefix path like
 * `/myapp-extra` was "inside /myapp" for the strips but not the 308; today the
 * 308 masks it, but the divergent guards are a latent footgun). This helper uses
 * the exact-or-`bp + '/'` boundary everywhere.
 *
 * Plain JS only — no backticks (this is itself inside a template literal) and no
 * `${}` (no interpolation needed). Requires `cf` to be in scope (each generated
 * function declares `import cf from 'cloudfront';` first).
 */
const SHARED_CF_HELPERS = `var KVS = cf.kvs();
async function getJson(key, dflt) {
  try { var raw = await KVS.get(key); return JSON.parse(raw); } catch (e) { return dflt; }
}
function matchPattern(uri, pattern) {
  // Fast path: no wildcard → exact match.
  if (pattern.indexOf('*') === -1) {
    return uri === pattern ? { tail: '' } : null;
  }
  // Fast path: single trailing '*' → prefix match, capturing the tail (used to
  // splice into wildcard redirect destinations).
  if (pattern.indexOf('*') === pattern.length - 1 && pattern.lastIndexOf('*') === pattern.length - 1) {
    var prefix = pattern.substring(0, pattern.length - 1);
    if (uri.indexOf(prefix) === 0) return { tail: uri.substring(prefix.length) };
    return null;
  }
  // General glob with '*' anywhere (incl. mid-segment). A non-trailing '*'
  // matches a run of any chars EXCEPT '/' (a SINGLE path segment), so
  // '/api/*/data' matches '/api/foo/data' but NOT '/api/foo/bar/data'. A
  // trailing '*' matches the rest, including '/'. Literal scan (no regex —
  // CloudFront Functions JS forbids dynamic RegExp from strings reliably).
  return globMatch(uri, pattern);
}
function globMatch(uri, pattern) {
  var ui = 0, pi = 0;
  while (pi < pattern.length) {
    var pc = pattern.charAt(pi);
    if (pc === '*') {
      var isTrailing = pi === pattern.length - 1;
      pi++;
      if (isTrailing) { return { tail: uri.substring(ui) }; }
      var nextLit = pattern.charAt(pi);
      while (ui < uri.length && uri.charAt(ui) !== nextLit && uri.charAt(ui) !== '/') { ui++; }
      if (ui >= uri.length || uri.charAt(ui) !== nextLit) { return null; }
    } else {
      if (ui >= uri.length || uri.charAt(ui) !== pc) { return null; }
      ui++; pi++;
    }
  }
  return ui === uri.length ? { tail: '' } : null;
}
function stripBasePath(uri, bp) {
  // Consistent boundary guard: strip ONLY an exact basePath or a 'bp/' prefix,
  // so '/myapp-extra' is NOT treated as under '/myapp'. Empty result → '/'.
  if (!bp) { return uri; }
  if (uri === bp) { return '/'; }
  if (uri.indexOf(bp + '/') === 0) {
    var stripped = uri.substring(bp.length);
    return stripped.length === 0 ? '/' : stripped;
  }
  return uri;
}`;

/**
 * Viewer-request CloudFront Function (JS 2.0). Reads the route table + metadata
 * from the associated KVS, evaluates redirects → basePath → origin selection →
 * URI rewrite. Build-independent (everything build-specific is in KVS).
 *
 * Pattern match semantics preserved from the per-behavior model:
 *   - exact (`/old-page`) and suffix-wildcard (`/old/*`, captured tail).
 *   - directory-index (`/about` → `/about/index.html`) for non-SPA.
 *   - SPA fallback (`/index.html`) for extensionless non-`.well-known` paths.
 *   - basePath canonical 308 + strip on static; kept on compute.
 *   - static → `/builds/<buildId>/` prefix; compute keeps URI + x-forwarded-host.
 *   - HTML documents resolve from the CURRENT build (never a pinned `__dpl`
 *     cookie build) so HTML, the response-stamped cookie, and the HTML's
 *     content-hashed assets always agree on one generation (issue #245).
 *
 * Issue #245 rationale (returning-visitor blank page): the viewer-RESPONSE
 * function stamps `__dpl = meta.b` (the current build) on every HTML response.
 * If the viewer-request function honored the cookie for HTML too, a returning
 * visitor holding an old `__dpl` would be served the OLD build's HTML while
 * their cookie advanced to the new build; the old HTML's content-hashed assets
 * (which exist only under the old `builds/<id>/` prefix) would then rewrite to
 * the new build prefix and 404 → a blank page. So HTML always resolves from
 * `meta.b`, applied AFTER the SPA/directory-index fallback (which rewrites
 * extensionless routes to `.../index.html`, so the `.html` suffix check covers
 * the SPA shell too). Assets keep honoring the cookie so an already-loaded page
 * stays consistent (old prefixes are retained via `prune: false`) until the
 * next HTML navigation lands the visitor on the current build.
 *
 * Caveat: an in-session HTML *partial* fetch (HTMX, Turbo Frames, etc.) whose
 * URI ends in `.html` also lands on the current build rather than the visitor's
 * cookie build — a deliberate departure from the assets-honor-the-cookie rule,
 * since these are treated as HTML documents. Acceptable for the targeted apps
 * (a partial is fetched fresh, not a build-pinned content-hashed asset).
 *
 * The suffix test is `uri.slice(-5) === '.html'`, NOT
 * `uri.lastIndexOf('.html') === uri.length - 5`: for a 4-char non-HTML URI like
 * `/x.y` the latter compares `-1 === -1` (true) and would wrongly force that
 * asset onto the current build, skipping its `__dpl` pin — the exact #245 bug,
 * inverted. `slice(-5)` on a <5-char string returns the whole string, never `.html`.
 *
 * NOTE: this function source ships to CloudFront, which enforces a 10 KB code
 * limit — keep in-function comments terse (the rationale lives here in the
 * JSDoc, which does NOT ship).
 */
export const generateKvsRouterRequestCode = (): string => `import cf from 'cloudfront';
${SHARED_CF_HELPERS}
function buildQueryString(request) {
  return request.querystring && Object.keys(request.querystring).length > 0
    ? '?' + Object.keys(request.querystring).map(function(k){ var v = request.querystring[k]; return v.multiValue ? v.multiValue.map(function(mv){ return k + '=' + mv.value; }).join('&') : k + '=' + v.value; }).join('&')
    : '';
}
async function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var meta = await getJson('meta', null);
  if (!meta) { return request; }

  // 0. Already-prefixed asset fetches (CloudFront custom-error responses
  // re-request /builds/<id>/<page> through this same behavior). Send straight
  // to S3 with no re-prefix / no redirect / no rewrite.
  if (uri.indexOf('/builds/') === 0) {
    cf.selectRequestOriginById(meta.oS3);
    return request;
  }

  // 0b. www <-> apex canonical 301 (runs before everything else).
  if (meta.ww) {
    var host = request.headers.host && request.headers.host.value;
    var qs = buildQueryString(request);
    if (meta.ww === 'toApex' && host && host.indexOf('www.') === 0) {
      return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: 'https://' + host.substring(4) + uri + qs } } };
    }
    if (meta.ww === 'toWww' && host && host.indexOf('www.') !== 0) {
      return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: 'https://www.' + host + uri + qs } } };
    }
  }

  // 1. redirects (chunked, first match wins)
  for (var di = 0; di < meta.dc; di++) {
    var drows = await getJson('d' + di, []);
    for (var j = 0; j < drows.length; j++) {
      var m = matchPattern(uri, drows[j][0]);
      if (m) {
        var dest = drows[j][1];
        // Splice the captured tail into a wildcard destination. Guard on the
        // DESTINATION shape (trailing '*'), NOT on m.tail being truthy: an exact
        // hit on a wildcard prefix (e.g. request '/old/' against source '/old/*')
        // yields tail '' , and a truthiness guard would skip the splice and leak
        // the literal '*' into Location (-> '/new/*'). Always strip the trailing
        // '*' and append the tail (empty string included).
        if (dest.charAt(dest.length - 1) === '*') {
          dest = dest.substring(0, dest.length - 1) + (m.tail || '');
        }
        return { statusCode: drows[j][2], statusDescription: 'Redirect', headers: { location: { value: dest } } };
      }
    }
  }

  var bp = meta.bp;

  // 2. assetPrefix strip — MUST run BEFORE the basePath 308 below.
  //
  // Next.js does NOT prefix assetPrefix with basePath: with basePath='/app' and
  // assetPrefix='/cdn-static' the browser fetches /cdn-static/_next/static/*
  // (no /app). assetPrefix is an ALTERNATIVE asset prefix, not additive with
  // basePath. So we strip the assetPrefix and, when a basePath is also set,
  // RE-MAP the asset into the basePath form (/cdn-static/_next/* ->
  // /app/_next/*). That puts it in the exact shape a normal (no-assetPrefix)
  // basePath asset already has, so it matches the basePath-prefixed route table,
  // the basePath 308 below does NOT fire (it is now under basePath), and the
  // static branch (4c) strips basePath back off before the build-id rewrite.
  //
  // Ordering matters: if the basePath 308 ran first it would see /cdn-static/...
  // (not under /app) and 308 to /app/cdn-static/... -> 404 -> the browser
  // rejects the HTML 404 as a non-executable script (the reported bug).
  if (meta.aP && (uri === meta.aP || uri.indexOf(meta.aP + '/') === 0)) {
    uri = uri.substring(meta.aP.length);
    if (uri.length === 0) { uri = '/'; }
    if (bp && uri !== bp && uri.indexOf(bp + '/') !== 0) {
      uri = uri === '/' ? bp + '/' : bp + uri;
    }
  }

  // 2b. basePath canonical 308. MUST preserve the query string — e.g.
  // /_next/image?url=...&w=64 redirecting to /app/_next/image WITHOUT the query
  // hits the image optimizer with no url param -> 400 "url parameter is
  // required" (and any ?ms=/?tag= API param is likewise lost). Mirror the www
  // 301 above and append the rebuilt query string.
  if (bp) {
    if (uri !== bp && uri.indexOf(bp + '/') !== 0) {
      var target = uri === '/' ? bp + '/' : bp + uri;
      return { statusCode: 308, statusDescription: 'Permanent Redirect', headers: { location: { value: target + buildQueryString(request) } } };
    }
  }

  // 3. origin selection: scan route table for first match. Also try the
  // trailing-slash-normalized form so a route stored as exact '/about' still
  // matches a '/about/' request (the old per-behavior model emitted derived
  // bare-path behaviors for this; here we normalize at match time). Without
  // this, '/about/' would miss → default to the SSR origin on compute deploys,
  // re-rendering a page that should be served statically from S3.
  var altUri = (uri.length > 1 && uri.charAt(uri.length - 1) === '/')
    ? uri.substring(0, uri.length - 1)
    : null;
  var kind = null;
  for (var ri = 0; ri < meta.rc && kind === null; ri++) {
    var rrows = await getJson('r' + ri, []);
    for (var k = 0; k < rrows.length; k++) {
      if (matchPattern(uri, rrows[k][0]) || (altUri !== null && matchPattern(altUri, rrows[k][0]))) {
        kind = rrows[k][1]; break;
      }
    }
  }
  // Default: server if present, else static (S3).
  if (kind === null) { kind = meta.srv ? 'c' : 's'; }

  // 4a. image-opt origin — strip basePath, then keep URI (no build-id prefix).
  // The image optimizer (Next /_next/image, Nuxt IPX /_ipx) parses the source
  // path relative to its OWN base (e.g. IPX baseURL '/_ipx'), so a deployed
  // basePath like '/myapp' must be removed first — otherwise the optimizer
  // sees '/myapp/_ipx/...' , fails to match its prefix, and 404s. (Mirrors the
  // basePath strip the static branch already does.)
  if (kind === 'i') {
    uri = stripBasePath(uri, bp);
    request.uri = uri;
    cf.selectRequestOriginById(meta.oImg);
    return request;
  }
  // 4b. compute/server origin — keep URI, set x-forwarded-host, select server.
  if (kind === 'c') {
    cf.selectRequestOriginById(meta.oSrv);
    var host = request.headers.host ? request.headers.host.value : undefined;
    if (host) { request.headers['x-forwarded-host'] = { value: host }; }
    return request;
  }
  // 4c. static origin (S3): basePath strip → directory-index/SPA → build-id
  // prefix. (assetPrefix was already stripped up front in step 2b.)
  cf.selectRequestOriginById(meta.oS3);
  uri = stripBasePath(uri, bp);
  // resolve build-id from skew cookie (__dpl) if valid, else metadata default.
  // Only honor the cookie when skew protection is enabled — a stale __dpl from
  // a previously-enabled deploy must not pin a visitor to a deleted build.
  var buildId = meta.b;
  if (meta.sk) {
    var cookie = request.cookies['__dpl'];
    if (cookie) { var v = cookie.value; if (/^[a-zA-Z0-9-]{1,64}$/.test(v)) { buildId = v; } }
  }
  if (meta.spa) {
    var seg = uri.substring(uri.lastIndexOf('/') + 1);
    if (seg.indexOf('.') === -1 && uri.indexOf('/.well-known/') !== 0) { uri = '/index.html'; }
  } else {
    if (uri.charAt(uri.length - 1) === '/') {
      uri = uri + 'index.html';
    } else {
      var seg2 = uri.substring(uri.lastIndexOf('/') + 1);
      if (seg2.indexOf('.') === -1) { uri = uri + '/index.html'; }
    }
  }
  // HTML always resolves from the current build; assets honor __dpl (see #245 in JSDoc).
  if (uri.slice(-5) === '.html') { buildId = meta.b; }
  request.uri = '/builds/' + buildId + uri;
  return request;
}`;

/**
 * Viewer-request guard for the sentinel behaviors (`/__blocks_origin_server/*`,
 * `/__blocks_origin_image/*`). Those behaviors exist ONLY so CDK materializes
 * the server/image origins + their OAC — the KVS router reaches the origins via
 * `selectRequestOriginById`, never via these patterns. A direct client request
 * to a sentinel path would otherwise hit the SSR Lambda (without the router's
 * x-forwarded-host injection) or the image origin, bypassing all routing — a
 * foot-gun / SSRF-ish surface. This guard 403s any such request.
 */
export const generateSentinelGuardCode = (): string => `function handler(event) {
  return {
    statusCode: 403,
    statusDescription: 'Forbidden',
    headers: { 'content-type': { value: 'text/plain' } },
    body: 'Forbidden'
  };
}`;

/**
 * Viewer-request CloudFront Function for the Lambda@Edge route behaviors
 * (`runtime: 'edge'`) when a basePath is configured.
 *
 * OpenNext compiles each edge bundle's internal route table basePath-RELATIVE
 * (e.g. `_ROUTES=[{regex:["^/edge$"]}]`, `["^/api/edge$"]`) and matches it
 * against the FULL request path. Under a deployed basePath the dedicated edge
 * behavior forwards `/app/edge`, which the bundle's `^/edge$` regex does not
 * match → it throws `No route found` → CloudFront returns 503. The KVS router
 * already strips basePath before forwarding to the static/image/compute
 * origins; the edge behaviors bypass the KVS router (they have their own
 * behavior), so they need the same strip here, at viewer-request, before the
 * Lambda@Edge origin-request function runs.
 *
 * The basePath is BAKED INTO the function source (not read from KVS) because
 * this runs on a dedicated edge behavior that never consults the KVS router.
 * Generated only when basePath is set; behaviors without a basePath attach no
 * such function. A bare `${basePath}` (no trailing segment) maps to `/`.
 */
export const generateEdgeBasePathStripCode = (basePath: string): string => {
  const bp = JSON.stringify(basePath);
  return `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var bp = ${bp};
  if (uri === bp) {
    request.uri = '/';
  } else if (uri.indexOf(bp + '/') === 0) {
    request.uri = uri.substring(bp.length);
  }
  return request;
}`;
};

/**
 * Viewer-response CloudFront Function (JS 2.0). Two jobs:
 *   1. Skew protection: set `__dpl` cookie to the active buildId on successful
 *      HTML responses (status-gated, per the original semantics).
 *   2. Per-pattern response headers: apply the manifest's `headers[]` rules by
 *      matching the request URI against the header table in KVS (the
 *      single-behavior replacement for per-pattern ResponseHeadersPolicies).
 *
 * @param skewMaxAge cookie Max-Age in seconds; 0 disables the cookie set.
 */
export const generateKvsRouterResponseCode = (skewMaxAge: number): string => `import cf from 'cloudfront';
${SHARED_CF_HELPERS}
async function handler(event) {
  var request = event.request;
  var response = event.response;
  var uri = request.uri;
  var meta = await getJson('meta', null);
  if (!meta) { return response; }

  // per-pattern headers
  for (var hi = 0; hi < meta.hc; hi++) {
    var hrows = await getJson('h' + hi, []);
    for (var j = 0; j < hrows.length; j++) {
      if (matchPattern(uri, hrows[j][0])) {
        var hdrs = hrows[j][1];
        for (var name in hdrs) { response.headers[name.toLowerCase()] = { value: hdrs[name] }; }
      }
    }
  }

  // skew-protection cookie (status-gated, HTML only)
  ${
    skewMaxAge > 0
      ? `if (response.statusCode < 400) {
    var ct = response.headers['content-type'] ? response.headers['content-type'].value : '';
    if (ct.indexOf('text/html') >= 0) {
      response.cookies['__dpl'] = { value: meta.b, attributes: 'Path=/; SameSite=Lax; Max-Age=${skewMaxAge}' };
    }
  }`
      : `// skew cookie disabled`
  }
  return response;
}`;
