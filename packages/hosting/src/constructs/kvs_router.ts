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
import type { DeployManifest, Redirect } from '../manifest/types.js';
import {
  prependBasePath,
  normalizeBasePath,
} from '../adapters/shared/basepath.js';
import { HostingError } from '../hosting_error.js';

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

/** Normalize a route pattern to the CloudFront form the function matches. */
const normalizePattern = (pattern: string, basePath?: string): string => {
  const p = pattern.startsWith('/') ? pattern : `/${pattern}`;
  return prependBasePath(basePath, p);
};

/**
 * The viewer-request CloudFront Function scans the route table SEQUENTIALLY per
 * request — for an unmatched/catch-all path (the worst case: the site root) it
 * reads + `JSON.parse`s every `r{n}` chunk before falling through to the
 * default origin. CloudFront Functions cap per-invocation compute, so a table
 * with many rows (→ many chunks → many parses) trips `RangeError: Instruction
 * limit exceeded` and the distribution 503s on EVERY route (the function runs
 * before any origin). SSG sites are the trigger: a framework emits one static
 * route per prerendered page (`/blog/post-1`, `/blog/post-2`, … hundreds), and
 * Nuxt additionally emits a `/<page>/*` subtree route per page — so 100 pages
 * became 200 rows / 7 chunks and tipped the limit.
 *
 * Coalesce sibling routes that share a parent directory AND a single kind into
 * one `parent/*` wildcard, collapsing those hundreds of rows to one. The scan
 * mirrors CloudFront's first-match-on-specificity ordering, so this preserves
 * matching for every EXISTING path: a request that hit `/blog/post-5` (exact)
 * now hits `/blog/*` with the same kind; a deeper, differently-kinded route
 * (e.g. `/blog/post-5/admin` = compute) keeps its own row and still sorts
 * BEFORE the broader wildcard (more literal segments), so it matches first.
 *
 * Semantic note (intentional, documented): for a compute-backed deploy where
 * the unmatched default is the SSR origin, a request to a NON-existent child of
 * a coalesced STATIC group (e.g. `/blog/never-generated`) now routes to S3 (→
 * 404/403 from the bucket) instead of the SSR Lambda's framework 404 page. For
 * prerendered content a miss is a 404 either way; only the 404 styling differs.
 * Coalescing a COMPUTE group, or any group in a static-only deploy, is a pure
 * no-op (the wildcard kind equals the default), so this only affects static
 * routes in a compute deploy — exactly the SSG fan-out we need to bound.
 */
export const coalesceRoutes = (
  rows: [string, RouteKind][],
): [string, RouteKind][] => {
  // Group by parent directory: strip a trailing '/*', then take everything up
  // to the last '/'. Both `/blog/p` and `/blog/p/*` → parent `/blog`.
  const groups = new Map<string, [string, RouteKind][]>();
  const order: string[] = [];
  for (const r of rows) {
    let p = r[0];
    if (p.endsWith('/*')) p = p.slice(0, -2);
    const slash = p.lastIndexOf('/');
    const parent = slash > 0 ? p.substring(0, slash) : '';
    if (!groups.has(parent)) {
      groups.set(parent, []);
      order.push(parent);
    }
    groups.get(parent)!.push(r);
  }
  const out: [string, RouteKind][] = [];
  for (const parent of order) {
    const members = groups.get(parent)!;
    const uniformKind = members.every((m) => m[1] === members[0][1]);
    // Coalesce only a real fan-out (≥2) under a non-root parent of one kind.
    // A non-empty parent guarantees the wildcard is scoped to a subtree and
    // never becomes a bare `/*` that would swallow the whole site.
    if (members.length >= 2 && uniformKind && parent.length > 0) {
      out.push([`${parent}/*`, members[0][1]]);
    } else {
      out.push(...members);
    }
  }
  // Dedupe identical [pattern, kind] rows. Frameworks that emit BOTH a bare
  // `/<page>` and a `/<page>/*` subtree per page (Nuxt) coalesce each form to
  // the SAME `<parent>/*` wildcard, producing duplicate rows; collapse them so
  // the table stays minimal.
  const seen = new Set<string>();
  return out.filter(([p, k]) => {
    const key = `${p} ${k}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * Build the KVS key/value map for a deploy. Keys:
 *   - `meta`  : metadata blob (buildId, basePath, spaFallback, image prefix,
 *               origin ids, chunk counts).
 *   - `r{n}`  : route-table chunks — JSON `[[pattern, kind], ...]`.
 *   - `d{n}`  : redirect chunks    — JSON `[[source, dest, status], ...]`.
 *   - `h{n}`  : header chunks      — JSON `[[pattern, {name:value}], ...]`.
 */
export const buildKvsEntries = (input: BuildKvsInput): Record<string, string> => {
  const { manifest, buildId, hasServer, hasImage } = input;
  const edgeTargets = input.edgeTargets ?? new Set<string>();
  const basePath = manifest.basePath
    ? normalizeBasePath(manifest.basePath)
    : undefined;
  const imagePrefix = hasImage ? manifest.imageOptimization?.baseURL : undefined;

  // ---- route table ----
  // Each static/compute/image route becomes one [pattern, kind] row. Image-opt
  // and server routes are recorded so the function can pick their origin; every
  // other path falls through to: server (if hasServer) else S3.
  //
  // IMPORTANT — patterns are kept basePath-RELATIVE through coalescing, then
  // basePath is prepended ONCE afterwards. Coalescing groups routes by parent
  // directory and a non-root parent (`parent.length > 0`) of one kind collapses
  // to `parent/*`. If basePath were prepended FIRST, root-level routes like
  // `/_next/*`, `/blocks-logo.png`, `/BUILD_ID` (parent `''`, never coalesced)
  // would instead become `/app/_next/*`, `/app/blocks-logo.png` (parent `/app`)
  // and collapse into a single `/app/*` STATIC wildcard — which shadows EVERY
  // dynamic SSR route under basePath (`/app/api/echo` → S3 → 404). Coalescing
  // relative keeps the root parent at `''` so the behavior is identical to the
  // no-basePath case, just shifted under the prefix.
  const rows: [string, RouteKind][] = [];
  for (const route of manifest.routes) {
    if (route.pattern === '/*' || route.pattern === '*') continue; // catch-all is implicit
    // Lambda@Edge route functions get a dedicated CloudFront behavior that
    // takes precedence over the default behavior — exclude them from the KVS
    // table so the router never (mis)classifies them as default-server compute.
    if (edgeTargets.has(route.target)) continue;
    // basePath-RELATIVE pattern (no prefix yet — see note above).
    const rel = normalizePattern(route.pattern);
    const isStatic = route.target === 'static' || route.target === 's3';
    // A route is image-opt when it targets the image origin (Next emits
    // target 'image-optimization' for `/_next/image*`) OR when it matches the
    // configured IPX prefix (Nuxt's `/_ipx/*`). Gate only on `hasImage` (the
    // origin must exist) — NOT on `imagePrefix`, which Next never sets.
    // Compare against the RELATIVE image prefix (imagePrefix is itself stored
    // basePath-relative), matching the relative `rel` pattern above.
    const isImage =
      hasImage &&
      (route.target === 'image-optimization' ||
        (imagePrefix !== undefined &&
          rel === normalizePattern(`${imagePrefix}/*`)));
    const kind: RouteKind = isImage ? 'i' : isStatic ? 's' : 'c';
    rows.push([rel, kind]);
  }
  // Coalesce SSG fan-out (many sibling pages under one parent, one kind) into a
  // single `parent/*` wildcard so the per-request edge scan stays bounded and
  // never trips the CloudFront Function instruction limit. See coalesceRoutes.
  // Runs on RELATIVE patterns (see note above); basePath is prepended next.
  const coalescedRel = coalesceRoutes(rows);

  // Prepend basePath ONCE, after coalescing. prependBasePath is idempotent, so
  // a pattern that somehow already carries the prefix is left intact.
  const coalesced: [string, RouteKind][] = coalescedRel.map(([p, k]) => [
    prependBasePath(basePath, p),
    k,
  ]);

  // Sort by descending specificity (literal segments, then length) so the
  // function's first-match scan mirrors CloudFront's old behavior ordering. A
  // coalesced `/blog/*` (1 literal seg) sorts AFTER any retained deeper route
  // (e.g. `/blog/x/admin`, 3 segs), preserving first-match correctness.
  coalesced.sort((a, b) => specificity(b[0]) - specificity(a[0]));

  // ---- redirects (basePath-prefixed, unbounded — no 100 cap) ----
  const redirects = manifest.redirects ?? [];
  const redirectRows: [string, string, number][] = redirects.map(
    (r: Redirect) => [
      prependBasePath(basePath, r.source),
      prependBasePath(basePath, r.destination),
      r.statusCode,
    ],
  );

  // ---- per-pattern response headers ----
  const headerRows: [string, Record<string, string>][] = (
    manifest.headers ?? []
  ).map((h) => [normalizePattern(h.source, basePath), h.headers]);

  const routeChunks = chunkRows(coalesced);
  const redirectChunks = chunkRows(redirectRows);
  const headerChunks = chunkRows(headerRows);

  const meta = {
    b: buildId,
    bp: basePath ?? '',
    spa: manifest.staticAssets.spaFallback ? 1 : 0,
    img: imagePrefix ?? '',
    srv: hasServer ? 1 : 0,
    // assetPrefix (Next.js): the router strips this prefix from a static URI
    // before the build-id rewrite so prefixed asset URLs resolve to the same
    // S3 objects as unprefixed ones. Empty string = no prefix.
    aP: manifest.assetPrefix ?? '',
    // www↔apex canonical redirect mode ('' = none).
    ww: input.wwwRedirect && input.wwwRedirect !== 'none' ? input.wwwRedirect : '',
    // skew protection on? When 0 the router ignores any `__dpl` build-pin
    // cookie (a stale cookie from a previously-enabled deploy must not pin a
    // visitor to a now-deleted build).
    sk: input.skewEnabled ? 1 : 0,
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
  if (tooManyChunks > KVS_BUDGET.maxChunksPerTable) {
    throw new HostingError('TooManyRoutesError', {
      message: `Edge route table needs ${tooManyChunks} chunks for one table, exceeding the safe per-request read budget of ${KVS_BUDGET.maxChunksPerTable}.`,
      resolution:
        'Reduce the number of routes/redirects/headers, or consolidate them ' +
        'into wildcard patterns. The KVS edge router reads chunks sequentially ' +
        'per request, so an unbounded table risks the CloudFront Function ' +
        'compute-utilization limit at the edge.',
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
 * Specificity score for a route/behavior pattern. Higher = more specific =
 * should match first. Literal path segments dominate, then raw length. Used to
 * order the KVS route-table scan AND (exported) to order CloudFront edge-route
 * behaviors, which are first-match-wins with no longest-prefix preference — so
 * a literal `/api/edge/special` must sort before a wildcard `/api/edge/*`.
 */
export const routeSpecificity = (pattern: string): number => {
  const literalSegments = pattern
    .split('/')
    .filter((s) => s !== '' && s !== '*').length;
  return literalSegments * 1000 + pattern.length;
};

/** @deprecated internal alias — use {@link routeSpecificity}. */
const specificity = routeSpecificity;

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
 */
export const generateKvsRouterRequestCode = (): string => `import cf from 'cloudfront';
var KVS = cf.kvs();
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
  // General path: glob with '*' anywhere (incl. mid-segment, e.g.
  // /api/*/admin). This is OUR framework-route matcher, NOT CloudFront behavior
  // selection: a non-trailing '*' matches a run of any chars EXCEPT '/' (a
  // SINGLE path segment), so '/api/*/data' matches '/api/foo/data' but NOT
  // '/api/foo/bar/data'. (CloudFront's own path patterns differ — there '*'
  // crosses '/'.) A trailing '*' matches the rest, including '/'. Implemented as
  // a literal scan (no regex — CloudFront Functions JS forbids dynamic RegExp
  // from strings reliably).
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
      var nextLit = pattern.charAt(pi); // literal that ends this wildcard run
      // consume uri chars (not '/') until we hit nextLit
      while (ui < uri.length && uri.charAt(ui) !== nextLit && uri.charAt(ui) !== '/') { ui++; }
      if (ui >= uri.length || uri.charAt(ui) !== nextLit) { return null; }
    } else {
      if (ui >= uri.length || uri.charAt(ui) !== pc) { return null; }
      ui++; pi++;
    }
  }
  return ui === uri.length ? { tail: '' } : null;
}
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
    if (bp && uri.indexOf(bp) === 0) {
      uri = uri.substring(bp.length);
      if (uri.length === 0) { uri = '/'; }
      request.uri = uri;
    }
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
  if (bp && uri.indexOf(bp) === 0) {
    uri = uri.substring(bp.length);
    if (uri.length === 0) { uri = '/'; }
  }
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
var KVS = cf.kvs();
async function getJson(key, dflt) {
  try { var raw = await KVS.get(key); return JSON.parse(raw); } catch (e) { return dflt; }
}
function matchPattern(uri, pattern) {
  if (pattern.indexOf('*') === -1) { return uri === pattern; }
  if (pattern.indexOf('*') === pattern.length - 1 && pattern.lastIndexOf('*') === pattern.length - 1) {
    return uri.indexOf(pattern.substring(0, pattern.length - 1)) === 0;
  }
  return globMatch(uri, pattern) !== null;
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
