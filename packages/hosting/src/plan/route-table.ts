/**
 * Neutral route table — the service-agnostic routing model.
 *
 * This module owns the PURE routing logic that turns a {@link DeployManifest}'s
 * `routes[]` into an ordered list of `{pattern, kind}` entries, independent of
 * any front-door service (CloudFront, ALB, API Gateway, …). A front-door
 * adapter renders these entries into its own primitive:
 *   - CloudFront: KVS chunks read by a CloudFront Function (see `kvs_router.ts`).
 *   - ALB (future): listener rules → target groups.
 *   - API Gateway (future): routes → integrations.
 *
 * `coalesceRoutes` and `routeSpecificity` live here (not in the CloudFront
 * renderer) because they are pure routing concerns every adapter shares. The
 * CloudFront renderer re-exports them for back-compat.
 */
import type { DeployManifest } from '../manifest/types.js';
import { prependBasePath } from '../adapters/shared/basepath.js';

/**
 * Neutral route kind — the semantic classification of a route, independent of
 * any wire encoding. A CloudFront renderer maps these to its terse codes
 * (`static → 's'`, `server → 'c'`, `image → 'i'`); an ALB renderer maps them to
 * target groups.
 */
export type RouteKind = 'static' | 'server' | 'image';

/** One entry in the neutral route table: a URL pattern and the origin kind it selects. */
export type RouteEntry = {
  /** URL pattern (basePath-prefixed, CloudFront/glob form). */
  pattern: string;
  /** Which origin kind this pattern routes to. */
  kind: RouteKind;
};

/**
 * Terse route-kind codes used by the CloudFront KVS renderer (kept small to
 * respect the 1 KB per-value KVS limit). This encoding is a CloudFront concern,
 * but `coalesceRoutes` operates on it because it is the historical, well-tested
 * shape; {@link buildRouteTable} converts to/from the neutral {@link RouteKind}.
 */
export type TerseRouteKind = 's' | 'c' | 'i';

const NEUTRAL_OF_TERSE: Record<TerseRouteKind, RouteKind> = {
  s: 'static',
  c: 'server',
  i: 'image',
};
const TERSE_OF_NEUTRAL: Record<RouteKind, TerseRouteKind> = {
  static: 's',
  server: 'c',
  image: 'i',
};

/** Normalize a route pattern to the CloudFront form the router matches. */
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
 * a coalesced STATIC group (e.g. `/blog/never-generated`) routes to S3 (→
 * 404/403 from the bucket) instead of the SSR Lambda. This is SAFE for FROZEN
 * prerendered content (Nuxt prerender / Astro `prerender = true`): those pages
 * are baked at build time with no on-demand render, so a non-built child
 * genuinely does not exist and S3-404 is the correct outcome.
 *
 * It would be UNSAFE only for true on-demand fallback — Next ISR
 * `fallback: 'blocking'`/`true`, where a non-prerendered child is supposed to
 * render at the SSR Lambda, not 404. That combination is NOT reachable here,
 * verified live (2026-06-30): OpenNext does not emit one static route per
 * prerendered page — it routes `/products/*`, `/blog/*` etc. through the
 * catch-all to the SSR origin (the live KVS route table carries zero per-page
 * static rows for them). So an ISR child like `/app/products/99999` hits
 * compute and renders on demand (HTTP 200), never the coalesced wildcard. The
 * per-page static-row fan-out that coalescing bounds is a Nuxt/Astro trait, and
 * those frameworks have no on-demand fallback — see the regression test
 * `coalesceRoutes — preserves a dynamic sibling under a coalesced static parent`.
 *
 * (This is why coalescing is NOT gated on `!hasServer`: the confirmed live
 * instruction-limit 503 was a Nuxt deploy, which IS `hasServer` — gating it off
 * for compute deploys would re-open that 503 for the exact case it fixed.)
 *
 * Coalescing a COMPUTE group, or any group in a static-only deploy, is a pure
 * no-op (the wildcard kind equals the default), so this only affects static
 * routes in a compute deploy — exactly the SSG fan-out we need to bound.
 */
export const coalesceRoutes = (
  rows: [string, TerseRouteKind][],
  options: { isrActive?: boolean } = {},
): [string, TerseRouteKind][] => {
  // When ISR/SWR is active on a compute deploy (`manifest.cache` set), a
  // non-prebuilt child of a coalesced STATIC group must render on-demand at the
  // SSR Lambda — not 404 from S3 (issue #7). Nitro/Nuxt DOES support on-demand
  // ISR (`routeRules` `isr`/`swr` → `manifest.cache = nitro-s3`), so the
  // "frozen prerender only" assumption does NOT hold for that subtree.
  //
  // A naive fix (don't coalesce static groups under ISR) keeps them as N
  // individual rows — which EXPLODES the route table for a large SSG+ISR site
  // (hundreds of rows → many KVS chunks → the per-request edge scan, DOUBLED
  // for a trailing-slash URI, trips the CloudFront Function compute limit →
  // FunctionExecutionError 503). So instead we STILL coalesce the fan-out into
  // ONE `parent/*` row (table stays bounded), but under ISR we flip that
  // wildcard's kind from static→COMPUTE. The SSR Lambda then serves the whole
  // subtree: prebuilt children from its ISR cache, non-prebuilt children
  // on-demand — never a hard S3 404. (Deploy-wide `isrActive` is the only
  // signal available here; sending genuinely-frozen prerendered pages through
  // the Lambda's cache is a minor efficiency tradeoff, not a correctness one.)
  const isrActive = options.isrActive === true;
  // Group by parent directory: strip a trailing '/*', then take everything up
  // to the last '/'. Both `/blog/p` and `/blog/p/*` → parent `/blog`.
  const groups = new Map<string, [string, TerseRouteKind][]>();
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
  const out: [string, TerseRouteKind][] = [];
  for (const parent of order) {
    const members = groups.get(parent)!;
    const uniformKind = members.every((m) => m[1] === members[0][1]);
    // Coalesce only a real fan-out (≥2) under a non-root parent of one kind.
    // A non-empty parent guarantees the wildcard is scoped to a subtree and
    // never becomes a bare `/*` that would swallow the whole site.
    const coalesceThis = members.length >= 2 && uniformKind && parent.length > 0;
    if (coalesceThis) {
      // Under ISR, a coalesced STATIC group becomes a COMPUTE wildcard (see
      // note above) so non-prebuilt children render on-demand instead of
      // 404ing from S3. Compute/image groups keep their kind.
      const kind: TerseRouteKind =
        isrActive && members[0][1] === 's' ? 'c' : members[0][1];
      out.push([`${parent}/*`, kind]);
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

/** Inputs to {@link buildRouteTable}. All service-agnostic. */
export type BuildRouteTableInput = {
  manifest: DeployManifest;
  /** Whether the deploy has a server (compute) origin. */
  hasServer: boolean;
  /** Whether an image-optimization origin exists. */
  hasImage: boolean;
  /** basePath-relative image-opt prefix (e.g. Nuxt IPX `/_ipx`), or undefined. */
  imagePrefix?: string;
  /** Normalized `manifest.basePath`, or undefined. */
  basePath?: string;
  /**
   * Compute names that are Lambda@Edge route functions (OpenNext `runtime:
   * 'edge'` split bundles). Routes targeting these are served by a dedicated
   * CloudFront behavior and MUST be excluded from the neutral table so the
   * router never classifies them as default-server compute.
   */
  edgeTargets?: Set<string>;
  /**
   * Whether ISR/SWR is active (`hasServer && manifest.cache !== undefined`).
   * When true, a coalesced STATIC group flips to a COMPUTE wildcard so
   * non-prebuilt children render on-demand instead of 404ing from S3.
   */
  isrActive?: boolean;
};

/**
 * Build the neutral, ordered route table from a manifest.
 *
 * Steps (identical to the historical inline logic in the CloudFront renderer,
 * lifted here so every front-door adapter shares one implementation):
 *   1. Classify each `manifest.routes` entry as static / server / image
 *      (basePath-RELATIVE patterns; catch-all and edge-target routes excluded).
 *   2. Coalesce SSG fan-out into `parent/*` wildcards (bounded table).
 *   3. Prepend basePath ONCE (idempotent), after coalescing.
 *   4. Sort by descending specificity (first-match ordering).
 *
 * Returns neutral `{pattern, kind}` entries; a renderer maps `kind` to its own
 * encoding.
 */
export const buildRouteTable = (input: BuildRouteTableInput): RouteEntry[] => {
  const { manifest, hasServer, hasImage, imagePrefix, basePath } = input;
  const edgeTargets = input.edgeTargets ?? new Set<string>();
  const isrActive = input.isrActive === true;

  const rows: [string, TerseRouteKind][] = [];
  for (const route of manifest.routes) {
    if (route.pattern === '/*' || route.pattern === '*') continue; // catch-all is implicit
    // Lambda@Edge route functions get a dedicated CloudFront behavior; exclude.
    if (edgeTargets.has(route.target)) continue;
    // basePath-RELATIVE pattern (prefix applied once, after coalescing).
    const rel = normalizePattern(route.pattern);
    const isStatic = route.target === 'static' || route.target === 's3';
    // Image-opt when it targets the image origin (Next `image-optimization`) OR
    // matches the configured IPX prefix (Nuxt `/_ipx/*`). Gate on `hasImage`.
    const isImage =
      hasImage &&
      (route.target === 'image-optimization' ||
        (imagePrefix !== undefined &&
          rel === normalizePattern(`${imagePrefix}/*`)));
    const kind: TerseRouteKind = isImage ? 'i' : isStatic ? 's' : 'c';
    rows.push([rel, kind]);
  }

  const coalescedRel = coalesceRoutes(rows, { isrActive });
  // Prepend basePath ONCE, after coalescing (idempotent).
  const coalesced: [string, TerseRouteKind][] = coalescedRel.map(([p, k]) => [
    prependBasePath(basePath, p),
    k,
  ]);
  // Sort by descending specificity (mirrors first-match ordering).
  coalesced.sort((a, b) => routeSpecificity(b[0]) - routeSpecificity(a[0]));

  return coalesced.map(([pattern, k]) => ({ pattern, kind: NEUTRAL_OF_TERSE[k] }));
};

/** Map a neutral route table to the terse `[pattern, code]` rows the KVS renderer chunks. */
export const toTerseRows = (entries: RouteEntry[]): [string, TerseRouteKind][] =>
  entries.map((e) => [e.pattern, TERSE_OF_NEUTRAL[e.kind]]);
