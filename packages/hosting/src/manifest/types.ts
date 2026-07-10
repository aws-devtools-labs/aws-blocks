/**
 * Framework-agnostic deployment manifest.
 *
 * Produced by framework adapters (Next.js/OpenNext, SvelteKit, Astro).
 * Consumed by the L3 HostingConstruct.
 *
 * The L3 NEVER knows which framework produced this manifest.
 */

export type DeployManifest = {
  version: 1;

  /** Named compute resources */
  compute: Record<string, ComputeResource>;

  /** Static asset configuration */
  staticAssets: {
    /** Path to static files directory */
    directory: string;
    /**
     * Cache-Control header for non-hashed assets (HTML, public/, etc.).
     * Defaults to `public, max-age=0, must-revalidate` so a redeploy
     * invalidates cached HTML on next request — required to avoid PWA
     * "brick" scenarios where a cached `index.html` references hashed
     * URLs that the new deploy already removed.
     */
    cacheControl?: string;
    /**
     * Glob patterns (relative to `directory`) of content-hashed asset
     * directories. Files matching these globs receive a long-lived,
     * `immutable` Cache-Control; everything else uses the short-lived
     * cache above. Adapters set this to the framework's hashed-output
     * dir(s):
     *
     *   Next.js / OpenNext: `['_next/static/*']`
     *   Astro:              `['_astro/*']`
     *   Nuxt / Nitro:       `['_nuxt/*']`
     *
     * When omitted, all assets receive the single `cacheControl` value
     * above (back-compat with adapters that don't yet declare hashed
     * paths).
     */
    immutablePaths?: string[];
    /**
     * Glob patterns (relative to `directory`) of files that must never
     * be cached. These receive `Cache-Control: no-cache, no-store,
     * must-revalidate`. Use for runtime config files (e.g.
     * `.blocks-sandbox/config.json`) that change between deploys and
     * must never serve stale content even briefly.
     */
    noCachePaths?: string[];
    /**
     * Whether this static deploy is a single-page app (SPA) that relies
     * on client-side routing, versus a multi-page site where each route
     * is its own prerendered HTML file.
     *
     * Controls how the CloudFront viewer-request function resolves
     * extensionless URLs:
     *
     *   - `true`  (SPA): every navigation request (no file extension) is
     *     rewritten to `/index.html` so the client-side router can handle
     *     deep links. Missing paths serve `index.html` at HTTP 200.
     *     Correct for Vite/React-Router/Vue-Router single-page apps.
     *   - `false` (multi-page): each request resolves to its own
     *     `<path>/index.html` (directory-index resolution). A request for
     *     `/about` serves `about/index.html`, NOT the home page. Correct
     *     for static-site generators (Astro static, Hugo, Eleventy) that
     *     prerender every route to a separate HTML file.
     *
     * Set by the adapter, which is the only layer that knows the
     * framework's routing model (the L3 is framework-blind). When
     * omitted, the L3 falls back to a heuristic: SPA mode when the deploy
     * has no compute AND no `errorPages` (preserved for back-compat with
     * adapters that don't yet declare this). Ignored when the manifest
     * has compute resources (SSR), since routing then flows through the
     * compute origin rather than static index resolution.
     */
    spaFallback?: boolean;
  };

  /** Route behaviors (maps URL patterns to compute/static) */
  routes: RouteBehavior[];

  /** Cache infrastructure (provisioned if present) */
  cache?: CacheConfig;

  /** Image optimization (separate Lambda if present) */
  imageOptimization?: ImageConfig;

  /** Middleware (edge function if present) */
  middleware?: MiddlewareConfig;

  /** Redirects */
  redirects?: Redirect[];

  /** Rewrites */
  rewrites?: Rewrite[];

  /** Custom response headers */
  headers?: CustomHeader[];

  /**
   * Optional URL prefix that the framework prepends to its built static
   * asset URLs (Next.js `assetPrefix`, Nuxt's `app.buildAssetsDir`).
   * When set, the L3 adds CloudFront behaviors at `/<prefix>/_next/*`
   * (or framework-specific pattern) so chunks/CSS/images load correctly.
   *
   * Format: leading slash, no trailing slash. Examples: `/shop-static`,
   * `/cdn`, `/foo/bar`. Set to `undefined` (or omit) when the framework
   * uses the default same-origin asset URLs.
   */
  assetPrefix?: string;

  /**
   * Static error pages emitted by the build (e.g. Next.js
   * `output: 'export'` writes `404.html` from `app/not-found.tsx`).
   *
   * When set, the L3 wires CloudFront `CustomErrorResponses` to serve
   * the named file at the original status code (404 → /404.html with
   * status 404), instead of the SPA fallback that maps every error to
   * /index.html with status 200. Typical entries:
   *
   *   { 404: '/404.html' }
   *   { 404: '/404.html', 500: '/500.html' }
   *
   * Static-only deploys without this field continue to use the SPA
   * fallback (suitable for client-routed React apps).
   */
  errorPages?: Partial<Record<404 | 500, string>>;

  /** Build ID for atomic deployments. */
  buildId?: string;

  /**
   * OVERRIDE for the CloudFront invalidation paths issued on every deploy,
   * AFTER the atomic KVS cutover. Most adapters leave this UNSET and let the
   * L3 pick the default (see below); set it only to customize the paths or to
   * opt out (`[]`).
   *
   * Why an invalidation is needed at all — the stale-HTML→403 problem:
   *
   * Atomic deploys write every object under a brand-new immutable
   * `builds/<buildId>/` prefix, so there is nothing stale to invalidate, and
   * HTML served from S3 carries `no-cache` (the 3-tier Cache-Control split in
   * hosting_construct). So a PURE-STATIC deploy (no compute) needs no
   * invalidation — Astro/Nuxt static pages prerender to S3 and propagate on
   * the next request.
   *
   * But ANY compute-backed deploy can edge-cache HTML that goes stale. The
   * shared SSR cache policy honors the origin's `Cache-Control`, so HTML
   * served by the compute origin with a long `s-maxage` is edge-cached keyed
   * on the VIEWER path (`/about`), NOT the build-id prefix. After a redeploy
   * that HTML still references the previous build's hashed assets
   * (`_next/static/*`, `_nuxt/*`, `_astro/*`), and the router rewrites those
   * asset requests to the CURRENT build prefix — which no longer contains
   * them → 403. This is NOT Next-specific:
   *   - Next/OpenNext: SSG/ISR HTML from the SSR Lambda → `s-maxage=31536000`.
   *   - Nuxt/Nitro: `routeRules` `cache.maxAge` / `swr` / `isr` emit
   *     `s-maxage=N` on compute-origin HTML (see nitro adapter).
   *   - Astro SSR: pages that set `Cache-Control` on the response.
   * The common trigger is "a compute origin serving cacheable HTML that
   * references build-prefixed hashed assets" — so the L3 scopes the
   * invalidation on `hasCompute`, not on the framework.
   *
   * Default (when this field is unset): the L3 issues `['/*']` for any deploy
   * with a compute origin, and nothing for pure-static deploys. The
   * invalidation is gated after the KvKeys cutover, so it only flushes the
   * previous build's cached pages — the new build's `builds/<id>/...` objects
   * were never cached, making `/*` effectively free. A compute app that emits
   * only `no-store` HTML still gets the invalidation, but it is a harmless
   * no-op. Set `[]` to opt out; set explicit patterns to narrow it.
   */
  invalidationPaths?: string[];

  /**
   * Adapter-supplied S3 lifecycle rules for orphaned per-build data
   * that lives outside the build prefix.
   *
   * The default `DeleteOldBuilds` lifecycle on `builds/<id>/` covers
   * everything under the build prefix. Some frameworks emit data
   * outside the build prefix that survives across builds and needs
   * its own expiration:
   *
   *   - Next.js writes `_next/data/<buildId>/...` JSON files used by
   *     getStaticProps fallbacks; older entries linger if the user
   *     toggles `output:` modes.
   *   - Custom adapters may emit similar per-build asset trees.
   *
   * Each entry installs an S3 lifecycle rule expiring objects under
   * `prefix` after `days`. Adapter code knows where its framework
   * writes these files; the L3 just installs whatever the adapter
   * declares. Empty / undefined → no extra rules.
   */
  lifecycle?: Array<{
    /** S3 key prefix to expire — e.g. `_next/data/`. */
    prefix: string;
    /** Days after object creation before expiration. */
    days: number;
  }>;

  /**
   * Optional URL prefix that prefixes every routable URL on the deployed
   * site. Maps to Next.js `basePath`, Astro `base`, Nuxt `app.baseURL`.
   * When set, every CloudFront behavior pattern is prefixed and the bare
   * domain root issues a 308 redirect to `/<basePath>/`.
   *
   * Format: leading slash, no trailing slash. Examples: `/app`, `/docs`.
   * Use `assetPrefix` for asset-only prefixing; `basePath` covers SSR
   * routes too.
   */
  basePath?: string;
};

export type ComputeResource = {
  /** How this compute runs */
  type: 'handler' | 'http-server' | 'edge';

  /** Path to the bundled code */
  bundle: string;

  /** Handler entry point (for type: 'handler') */
  handler?: string;

  /** Server entry point (for type: 'http-server') */
  entrypoint?: string;

  /** Port for http-server type */
  port?: number;

  /** Where to deploy */
  placement: 'regional' | 'global';

  /** Whether to enable response streaming */
  streaming?: boolean;

  /** Runtime */
  runtime?: string;

  /** Memory (MB) */
  memorySize?: number;

  /** Timeout (seconds) */
  timeout?: number;

  /** Environment variables */
  environment?: Record<string, string>;

  /** Optional provisioned concurrency for cold-start elimination */
  provisionedConcurrency?: number;
};

export type RouteBehavior = {
  /** URL pattern (regex or glob) */
  pattern: string;

  /** Target compute resource name, or 'static' */
  target: string;

  /** Fallback if target fails */
  fallback?: string;
};

export type CacheConfig = {
  /** Which compute resource handles cached content */
  computeResource: string;

  /**
   * Cache backend the adapter wants the L3 to provision.
   *
   * - `'opennext'` (default for backwards compatibility) — DynamoDB tag
   *   table + SQS revalidation queue + worker Lambda + S3 cache bucket.
   *   Used by the Next.js / OpenNext adapter.
   * - `'nitro-s3'` — single S3 bucket, no SQS, no worker. Used by the
   *   Nitro adapter; works with Nitro's `useStorage('cache')` model
   *   where refresh happens inline in the SSR Lambda.
   */
  driver?: 'opennext' | 'nitro-s3';

  /**
   * Whether tag-based revalidation is needed (provisions DynamoDB).
   * Only honoured when `driver === 'opennext'`.
   */
  tagRevalidation?: boolean;

  /**
   * Whether async revalidation queue is needed (provisions SQS).
   * Only honoured when `driver === 'opennext'`.
   */
  revalidationQueue?: boolean;

  /**
   * Background revalidation worker function.
   *
   * When present, a Lambda is deployed with the SQS revalidation queue as its
   * event source. This worker processes ISR revalidation messages and refreshes
   * stale pages in the background. Only honoured when `driver === 'opennext'`.
   */
  revalidationFunction?: {
    /** Path to the revalidation function bundle directory */
    bundle: string;
    /** Handler entry point (e.g. 'index.handler') */
    handler: string;
  };

  /**
   * Directory of prebuilt incremental-cache files to seed the S3 cache
   * bucket with at deploy time (OpenNext's `.open-next/cache`). Without
   * this, every prerendered ISR/SSG page is a cold render on first
   * request (cache MISS) until it self-populates. The L3 uploads this
   * directory's contents to the cache bucket under the build-id prefix
   * the runtime reads. Only honoured when `driver === 'opennext'`.
   */
  seedDirectory?: string;

  /**
   * One-shot initialization function that seeds the DynamoDB tag table
   * with the build's prebuilt tag→path rows (OpenNext's
   * `dynamodb-provider`, which reads its bundled `dynamodb-cache.json`).
   * The L3 wires it as a CloudFormation custom resource that runs once
   * per deploy. Without it, tag-based revalidation can't purge a page
   * until that page has been requested at least once. Only honoured
   * when `driver === 'opennext'` and `tagRevalidation` is true.
   */
  initFunction?: {
    /** Path to the initialization function bundle directory */
    bundle: string;
    /** Handler entry point (e.g. 'index.handler') */
    handler: string;
  };
};

export type ImageConfig = {
  /** Path to image optimization bundle */
  bundle: string;

  /** Handler entry point */
  handler: string;

  /** Supported formats */
  formats: string[];

  /** Max image sizes */
  sizes: number[];

  /**
   * Path prefix the image-opt Lambda serves. Defaults to `/_ipx` for
   * Nitro/@nuxt/image projects; users can override via
   * `runtimeConfig.ipx.baseURL` in nuxt.config. The CloudFront cache
   * behavior is wired at this path, and the Lambda's request handler
   * uses it to strip the prefix before passing the URL to IPX.
   */
  baseURL?: string;

  /**
   * Extra environment variables forwarded to the image-opt Lambda.
   * The L3 always sets BUCKET_NAME / BUCKET_REGION / BUCKET_KEY_PREFIX
   * for storage access; this is for framework-specific config (e.g.
   * IPX_BASE_URL when the user customizes the `/_ipx` prefix).
   */
  environment?: Record<string, string>;

  /**
   * Allowlist of remote image hostnames the image-opt service should
   * fetch from. Mirrors Astro's `image.domains` and Next.js's
   * `images.domains`. Forward-compat: the L3 does not consume this yet —
   * adapters write it for parity with the originating framework config.
   */
  domains?: string[];

  /**
   * More expressive allowlist than `domains`. Each entry can scope the
   * match by protocol/port/path prefix in addition to hostname. Mirrors
   * Next.js `images.remotePatterns`.
   */
  remotePatterns?: RemotePattern[];

  /**
   * Permit SVG sources through the image-opt pipeline. SVG can carry
   * arbitrary script payloads; off by default. Mirrors Next.js
   * `images.dangerouslyAllowSVG`.
   */
  dangerouslyAllowSVG?: boolean;

  /**
   * Minimum cache TTL (in seconds) the image-opt response should
   * advertise. Mirrors Next.js `images.minimumCacheTTL`. Wired onto the
   * image-opt Lambda's env at L3 time.
   */
  minimumCacheTTL?: number;
};

export type RemotePattern = {
  protocol?: 'http' | 'https';
  hostname: string;
  port?: string;
  pathname?: string;
};

export type MiddlewareConfig = {
  /** Path to middleware bundle */
  bundle: string;

  /** Handler entry point */
  handler: string;

  /** URL patterns this middleware matches */
  matchers: string[];
};

export type Redirect = {
  source: string;
  destination: string;
  statusCode: 301 | 302 | 307 | 308;
};

export type Rewrite = {
  source: string;
  destination: string;
};

export type CustomHeader = {
  source: string;
  headers: Record<string, string>;
};
