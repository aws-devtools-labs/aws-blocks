/**
 * Next.js adapter using opennextjs/aws.
 *
 * Runs OpenNext build, reads .open-next/ output, translates to DeployManifest.
 * The output manifest is framework-agnostic — the L3 construct never knows this
 * came from Next.js.
 */
import { spawn } from './spawn.js';
import { normalizeBasePath } from './shared/basepath.js';
import { validateCacheControl } from './shared/cache_control.js';
import { warnIfVercelCron } from './shared/feature_warnings.js';
import {
  type TrailingSlashMode,
  emitTrailingSlashRedirects,
} from './shared/trailing_slash.js';
import * as fs from 'fs';
import * as path from 'path';
import fg from 'fast-glob';
import semver from 'semver';
import { getPackageInfoSync } from 'local-pkg';
import { HostingError } from '../hosting_error.js';
import type {
  ComputeResource,
  CustomHeader,
  DeployManifest,
  Redirect,
  RemotePattern,
  RouteBehavior,
} from '../manifest/types.js';

export type NextjsAdapterOptions = {
  /** Project root directory */
  projectDir: string;
  /** Custom open-next.config.ts path (relative to projectDir) */
  configPath?: string;
  /** Skip the OpenNext build step (use pre-existing .open-next/ output) */
  skipBuild?: boolean;
};

// ---- OpenNext output types (internal) ----

type OpenNextOutput = {
  origins?: Record<string, OpenNextOrigin>;
  /**
   * Edge functions (Lambda@Edge bundles). OpenNext writes one entry per
   * edge function declared in the user's `functions: { ... }` config; each
   * one corresponds to a separate Lambda@Edge replica.
   */
  edgeFunctions?: Record<string, OpenNextEdgeFunction>;
  behaviors?: OpenNextBehavior[];
  additionalProps?: {
    [key: string]: unknown;
    disableIncrementalCache?: boolean;
    /**
     * OpenNext's `disableTagCache` — turns off the DynamoDB tag table while
     * keeping the S3 incremental cache. When true, we must NOT provision
     * DynamoDB (it would be an unused, billed resource). OpenNext also omits
     * the `dynamodb-provider` directory in this mode, which we treat as a
     * secondary signal.
     */
    disableTagCache?: boolean;
    imageOptimization?: boolean;
    /**
     * One-shot DynamoDB tag-table seeder (`dynamodb-provider`). OpenNext
     * emits this when the tag cache is enabled; its bundle contains a
     * CFN-custom-resource handler + the prebuilt `dynamodb-cache.json`.
     */
    initializationFunction?: { handler?: string; bundle?: string };
  };
};

type OpenNextOrigin = {
  type?: 'function' | 'ecs' | 'docker' | 'edge' | string;
  handler?: string;
  entrypoint?: string;
  port?: number;
  streaming?: boolean;
  runtime?: string;
  memorySize?: number;
  timeout?: number;
  environment?: Record<string, string>;
};

type OpenNextEdgeFunction = {
  bundle?: string;
  handler?: string;
  /** Always 'aws-lambda' for AWS-targeted edge functions in OpenNext. */
  wrapper?: string;
  /** 'aws-cloudfront' when placement is global (Lambda@Edge). */
  converter?: string;
};

type OpenNextBehavior = {
  pattern: string;
  /** Set when the route targets a regional origin (S3, regional Lambda). */
  origin?: string;
  /**
   * Set when the route targets an edge function — keyed off
   * `output.edgeFunctions[edgeFunction]`.
   */
  edgeFunction?: string;
  fallback?: string;
};

/**
 * Run the OpenNext build and translate its output into a DeployManifest.
 * @param options - Adapter options
 * @returns Framework-agnostic DeployManifest ready for the L3 construct
 */
export const nextjsAdapter = (
  options: NextjsAdapterOptions,
): DeployManifest => {
  const { projectDir, configPath, skipBuild } = options;

  const openNextDir = path.join(projectDir, '.open-next');
  const outputPath = path.join(openNextDir, 'open-next.output.json');

  if (!skipBuild) {
    // L3 routes the SSR Lambda through API Gateway REST + STREAM. REST sends
    // payload v1, OpenNext defaults to v2 — force the v1 converter + streaming
    // wrapper for `default`. OpenNext's `--config-path` flag silently fails
    // to load configs from non-default locations, so the file must live at
    // <projectDir>/open-next.config.ts.
    //
    // Edge route detection requires Next.js's compiled middleware-manifest.
    // Skip the pre-build when:
    //   (a) the manifest already exists (user/CI ran `next build`, or a
    //       previous deploy cached it), OR
    //   (b) the project's source declares no `runtime: 'edge'` routes —
    //       in that case detectEdgeRoutes returns empty and the generated
    //       open-next.config.ts has no functions{} block, so OpenNext's
    //       own build pass produces all the manifests we'd need.
    // Both branches eliminate one full Next.js build (~10-60s) without
    // changing correctness: when we DO need edge detection AND the manifest
    // is missing, runNextBuild fires.
    let cleanupConfig: (() => void) | undefined;
    if (!configPath) {
      if (
        !hasExistingMiddlewareManifest(projectDir) &&
        projectHasEdgeRuntimeRoutes(projectDir)
      ) {
        runNextBuild(projectDir);
      }
      const edgeRoutes = detectEdgeRoutes(projectDir);
      cleanupConfig = installGeneratedOpenNextConfig(projectDir, edgeRoutes);
    }
    try {
      runOpenNextBuild(projectDir, configPath);
    } finally {
      cleanupConfig?.();
    }

    // Warn when the installed @opennextjs/aws is outside the version
    // range these patches were tested against. We don't fail because
    // the patcher itself already throws `UpstreamPatchPatternChangedError`
    // on no-match — this warning gives a head's-up *before* the patcher
    // fires, so users hitting a fresh OpenNext version know to expect a
    // possible patch break and can pin back if needed.
    warnIfOpenNextOutOfRange(projectDir);

    // Patch OpenNext's bundled aws-lambda-streaming wrapper for API Gateway
    // STREAM framing. See patchStreamingWrapperForApiGateway for what changes.
    patchStreamingWrapperForApiGateway(openNextDir);

    // Patch each edge bundle's process import banner for Lambda@Edge
    // nodejs20.x compatibility. See patchEdgeBundleForLambdaEdge.
    patchEdgeBundlesForLambdaEdge(openNextDir);

    // Patch the image-optimization bundle for the Next.js 15.5 image-optimizer
    // signature change. See patchImageOptimizerForNext155.
    patchImageOptimizerForNext155(openNextDir);

    // Ensure the image-optimization Lambda has a linux-x64 sharp binary.
    // See installLinuxSharpForImageOptimizer.
    installLinuxSharpForImageOptimizer(openNextDir);
  }

  // Note: Injecting config files into server bundles is an integration-layer
  // concern, not an adapter concern. If a consumer needs files copied into
  // Lambda bundles, handle it in the orchestration layer that calls the adapter.

  if (!fs.existsSync(outputPath)) {
    throw new HostingError('OpenNextOutputNotFoundError', {
      message: `OpenNext output not found at ${outputPath}. Did the build succeed?`,
      resolution:
        'Ensure @opennextjs/aws is installed and the build completed successfully. ' +
        'Run `npx @opennextjs/aws build` manually to diagnose build failures.',
    });
  }

  let output: OpenNextOutput;
  try {
    output = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
  } catch (error) {
    throw new HostingError(
      'OpenNextOutputParseError',
      {
        message: `Failed to parse OpenNext output at ${outputPath}`,
        resolution:
          'The open-next.output.json file contains invalid JSON. Try running the build again.',
      },
      error as Error,
    );
  }

  const manifest = translateOpenNextOutput(output, openNextDir);

  // Lift simple Next.js redirects() / headers() rules out of the OpenNext
  // Lambda and into CloudFront. This eliminates a Lambda invocation for
  // matching paths (~150ms cold-start + ~5ms warm vs. ~5ms at the edge).
  // Complex rules (with `has`/`missing` conditions, regex captures, or
  // i18n locale groups) stay in the Lambda — see liftSimpleRoutesManifest
  // for the classifier. Anything we don't lift remains handled by the
  // OpenNext server bundle, so behavior is preserved.
  applyLiftedRoutesManifest(manifest, projectDir);
  applyAssetPrefix(manifest, projectDir);
  applyNextImageConfig(manifest, projectDir);

  // Warn (don't fail) when `vercel.json` declares crons: there is no general
  // scheduled-task wiring (EventBridge is used only for opt-in compute.warmup),
  // so a declared cron silently never fires.
  //
  // WebSocket is deliberately NOT detected for Next: there is no server-side
  // WS feature in Next to key off (WS needs a custom server OpenNext discards),
  // and a `ws`/`socket.io` dependency is overwhelmingly client-side usage that
  // works fine — flagging it would false-positive on legitimate apps.
  warnIfVercelCron(projectDir);

  // 3.2 — Next-specific orphaned-data lifecycle. `_next/data/<id>/...`
  // JSON files live OUTSIDE the build prefix and survive across
  // builds; without an explicit rule the bucket accumulates them
  // indefinitely. Previously hardcoded in storage_construct.ts; now
  // declared by the adapter so non-Next deploys don't carry a
  // dead-weight rule.
  manifest.lifecycle = [
    ...(manifest.lifecycle ?? []),
    { prefix: '_next/data/', days: 30 },
  ];

  // NOTE: deploy-time CloudFront invalidation (to clear edge-cached SSG/ISR
  // HTML that references the previous build's chunk hashes → 403) is NOT set
  // here. It is not Next-specific — any compute-backed deploy can edge-cache
  // stale HTML (Nuxt `routeRules` swr/isr, Astro SSR) — so the L3 issues the
  // invalidation for ANY deploy with a compute origin (gated on `hasCompute`,
  // default `['/*']`). Adapters set `manifest.invalidationPaths` only to
  // override/opt out. See the field doc in manifest/types.ts.

  // Strip Next's baked-in basePath from every pattern/source BEFORE returning,
  // so the manifest honors the cross-framework contract (adapters emit
  // basePath-RELATIVE patterns; the L3 prepends basePath exactly once). Next is
  // the lone framework that bakes basePath into its build artifacts — see
  // stripBakedBasePath. MUST run after applyAssetPrefix (which sets
  // manifest.basePath and appends trailing-slash redirects).
  stripBakedBasePath(manifest);

  return manifest;
};

/**
 * Remove a single leading `basePath` segment from a pattern/source.
 *
 * - `('/app', 'app/_next/*')`     → `'/_next/*'`   (no-leading-slash OpenNext form)
 * - `('/app', '/app/legacy')`     → `'/legacy'`
 * - `('/app', '/app')`            → `'/'`          (the basePath root itself)
 * - `('/app', '/about')`          → `'/about'`     (not under basePath — unchanged)
 * - `('/app', 'https://x/y')`     → `'https://x/y'`(external — unchanged)
 *
 * Boundary-safe: `/application/*` under basePath `/app` is NOT stripped (it does
 * not start with `'/app/'`). The inverse of {@link prependBasePath}.
 * @internal
 */
export const stripBasePathPrefix = (
  basePath: string,
  pattern: string,
): string => {
  const withLeading = pattern.startsWith('/') ? pattern : `/${pattern}`;
  if (withLeading === basePath) return '/';
  if (withLeading.startsWith(`${basePath}/`)) {
    return withLeading.substring(basePath.length);
  }
  return pattern; // not under basePath — leave exactly as-is
};

/**
 * Strip Next's baked-in `basePath` from route patterns and redirect/header
 * sources (and redirect destinations) so the manifest carries basePath-RELATIVE
 * patterns, matching the contract every other adapter (Astro `base`, Nuxt
 * `app.baseURL`) already follows.
 *
 * WHY: Next.js bakes its configured `basePath` into the OpenNext behavior
 * patterns (`app/_next/*`) AND into `routes-manifest.json` redirect/header
 * sources + destinations (`/app/legacy-home` → `/app`). The L3
 * (`buildKvsEntries`) then prepends `manifest.basePath` to every emitted
 * pattern — producing the DOUBLE prefix `/app/app/_next/*`, `/app/app/legacy`,
 * which matches nothing in the route table at request time, so every asset
 * falls through to the SSR Lambda and 404s (the reported bug). Stripping here
 * makes the single L3 prepend land correctly.
 *
 * No-op when `manifest.basePath` is unset (the common case). Idempotent:
 * stripping an already-relative pattern leaves it unchanged, and
 * `prependBasePath` is itself idempotent as a second safety net.
 * @internal
 */
export const stripBakedBasePath = (manifest: DeployManifest): void => {
  const bp = manifest.basePath;
  if (!bp) return;

  if (manifest.routes) {
    for (const route of manifest.routes) {
      route.pattern = stripBasePathPrefix(bp, route.pattern);
    }
  }
  if (manifest.redirects) {
    for (const r of manifest.redirects) {
      r.source = stripBasePathPrefix(bp, r.source);
      r.destination = stripBasePathPrefix(bp, r.destination);
    }
  }
  if (manifest.headers) {
    for (const h of manifest.headers) {
      h.source = stripBasePathPrefix(bp, h.source);
    }
  }
};

/**
 * Detect Next.js `assetPrefix` from the build's `required-server-files.json`
 * and copy it to the manifest. The L3 uses this to add CloudFront cache
 * behaviors at `/<prefix>/_next/*` so prefixed asset URLs resolve.
 *
 * Skips silently if the file is missing or assetPrefix is unset (most
 * apps).
 */
const applyAssetPrefix = (
  manifest: DeployManifest,
  projectDir: string,
): void => {
  const requiredServerFilesPath = path.join(
    projectDir,
    '.next',
    'required-server-files.json',
  );
  if (!fs.existsSync(requiredServerFilesPath)) return;
  let parsed: {
    config?: {
      assetPrefix?: string;
      basePath?: string;
      trailingSlash?: boolean;
    };
  };
  try {
    parsed = JSON.parse(fs.readFileSync(requiredServerFilesPath, 'utf-8'));
  } catch {
    return;
  }
  // basePath — the framework-side URL prefix for routes + assets. Read
  // alongside assetPrefix because they share the same JSON file.
  const bp = normalizeBasePath(parsed.config?.basePath);
  if (bp) {
    manifest.basePath = bp;
    process.stdout.write(
      `🔗 Detected Next.js basePath=${bp}; CloudFront behaviors will be prefixed.\n`,
    );
  }

  // trailingSlash — Next.js exposes a tri-state via boolean: true ⇒
  // 'always', false ⇒ 'never', undefined ⇒ 'ignore' (default).
  const tsRaw = parsed.config?.trailingSlash;
  const tsMode: TrailingSlashMode =
    tsRaw === true ? 'always' : tsRaw === false ? 'never' : 'ignore';
  applyTrailingSlashRedirects(manifest, projectDir, tsMode);

  const ap = parsed.config?.assetPrefix;
  if (typeof ap !== 'string' || ap === '') return;
  // Strip absolute-URL form (`https://cdn.example.com`) — only path-form
  // assetPrefix can be wired to a CloudFront behavior on the same
  // distribution. Absolute-URL assetPrefix means the user is fronting
  // their assets with a separate origin and we shouldn't touch it.
  if (/^https?:\/\//.test(ap)) return;
  // Normalize: ensure leading slash, no trailing slash.
  const normalized = '/' + ap.replace(/^\/+|\/+$/g, '');
  if (normalized === '/') return;
  manifest.assetPrefix = normalized;
  process.stdout.write(
    `🔗 Detected Next.js assetPrefix=${normalized}; will add CloudFront behaviors for prefixed asset paths.\n`,
  );
};

/**
 * Read Next.js `next.config.js#images` from `required-server-files.json`
 * and populate the optional fields on `manifest.imageOptimization`. By
 * the time this runs, `next build` has already validated the patterns,
 * so we trust the shape and only filter entries missing the required
 * `hostname`.
 */
const applyNextImageConfig = (
  manifest: DeployManifest,
  projectDir: string,
): void => {
  if (!manifest.imageOptimization) return;
  const requiredServerFilesPath = path.join(
    projectDir,
    '.next',
    'required-server-files.json',
  );
  if (!fs.existsSync(requiredServerFilesPath)) return;
  let parsed: {
    config?: {
      images?: {
        remotePatterns?: unknown;
        dangerouslyAllowSVG?: boolean;
        minimumCacheTTL?: number;
      };
    };
  };
  try {
    parsed = JSON.parse(fs.readFileSync(requiredServerFilesPath, 'utf-8'));
  } catch {
    return;
  }
  const images = parsed.config?.images;
  if (!images) return;

  if (Array.isArray(images.remotePatterns)) {
    const patterns: RemotePattern[] = [];
    for (const entry of images.remotePatterns) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as {
        protocol?: unknown;
        hostname?: unknown;
        port?: unknown;
        pathname?: unknown;
      };
      if (typeof e.hostname !== 'string' || e.hostname === '') continue;
      const p: RemotePattern = { hostname: e.hostname };
      if (e.protocol === 'http' || e.protocol === 'https') {
        p.protocol = e.protocol;
      }
      if (typeof e.port === 'string') p.port = e.port;
      if (typeof e.pathname === 'string') p.pathname = e.pathname;
      patterns.push(p);
    }
    if (patterns.length > 0) {
      manifest.imageOptimization.remotePatterns = patterns;
    }
  }
  if (typeof images.dangerouslyAllowSVG === 'boolean') {
    manifest.imageOptimization.dangerouslyAllowSVG = images.dangerouslyAllowSVG;
  }
  if (typeof images.minimumCacheTTL === 'number') {
    manifest.imageOptimization.minimumCacheTTL = images.minimumCacheTTL;
  }
};

/**
 * Read every Next.js manifest that lists routable URLs and emit
 * canonical-form redirects honoring the user's `trailingSlash`
 * setting. User-declared redirects from `liftSimpleRoutesManifest` are
 * already present and these are appended afterwards.
 *
 * No count cap: under KVS edge routing redirects are DATA (chunked `d{n}`
 * KVS entries the viewer-request function reads at runtime), not literals
 * inlined into the function source — so the old 10 KB-CloudFront-Function
 * code limit no longer applies. The real bound is the KVS store/chunk budget
 * enforced centrally in `buildKvsEntries` (kvs_router.ts), which throws a
 * friendly `TooManyRoutesError` / `RouteTableTooLargeError` if a deploy's
 * tables genuinely exceed the safe per-request read budget.
 *
 * Sources read (P1.8 — previously only prerender-manifest):
 *   - `.next/prerender-manifest.json#routes` — pages prerendered via
 *     `generateStaticParams` with known params, plus Pages Router
 *     `getStaticProps`. The original implementation only read this.
 *   - `.next/routes-manifest.json#staticRoutes[].page` — Pages Router
 *     pages with no dynamic segments (covers static pages even when
 *     they use `getServerSideProps`, where prerender-manifest is
 *     empty).
 *   - `.next/app-paths-manifest.json` — App Router page paths
 *     including the dynamic-route templates. We strip the `[...]`
 *     placeholders and emit a redirect for the static prefix; this
 *     covers the dynamic-route case where viewers land on a path
 *     that doesn't exist in `prerender-manifest` (P1.8 was
 *     "inconsistent UX" — `/posts/known-id` redirected,
 *     `/posts/unknown-id` did not).
 *
 * Static-only routes are deduplicated; dynamic routes contribute
 * their static prefix only (we can't enumerate every possible
 * `:id`). For the dynamic-route cases the SSR Lambda still has to
 * canonicalize at runtime — we just give the cheap edge case the
 * cheap edge handling.
 */
const applyTrailingSlashRedirects = (
  manifest: DeployManifest,
  projectDir: string,
  mode: TrailingSlashMode,
): void => {
  if (mode === 'ignore') return;

  const allPaths = new Set<string>();

  // Source 1: prerender-manifest (legacy)
  const prerenderManifestPath = path.join(
    projectDir,
    '.next',
    'prerender-manifest.json',
  );
  if (fs.existsSync(prerenderManifestPath)) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(prerenderManifestPath, 'utf-8'),
      ) as { routes?: Record<string, unknown> };
      for (const p of Object.keys(parsed.routes ?? {})) allPaths.add(p);
      
    } catch {
      // best-effort: malformed manifest leaves allPaths shorter, never blocks deploy
    }
  }

  // Source 2: routes-manifest staticRoutes (Pages Router)
  const routesManifestPath = path.join(
    projectDir,
    '.next',
    'routes-manifest.json',
  );
  if (fs.existsSync(routesManifestPath)) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(routesManifestPath, 'utf-8'),
      ) as { staticRoutes?: Array<{ page?: unknown }> };
      for (const route of parsed.staticRoutes ?? []) {
        if (typeof route.page === 'string' && route.page.startsWith('/')) {
          allPaths.add(route.page);
        }
      }
      
    } catch {
      // best-effort: same rationale as Source 1
    }
  }

  // Source 3: app-paths-manifest (App Router). The keys are the route
  // module paths (e.g. `/about/page`, `/blog/[slug]/page`); we trim
  // the trailing `/page` and strip `[...]` placeholders down to the
  // static prefix. Dynamic-only paths (whole path is a `[slug]`) are
  // skipped since there's no static prefix to redirect.
  const appPathsManifestPath = path.join(
    projectDir,
    '.next',
    'app-paths-manifest.json',
  );
  if (fs.existsSync(appPathsManifestPath)) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(appPathsManifestPath, 'utf-8'),
      ) as Record<string, unknown>;
      for (const key of Object.keys(parsed)) {
        // Strip `/page`, `/route`, `/layout` suffixes Next emits as
        // module file names. Layout / route handlers don't have
        // page paths but are harmless to skip.
        const trimmed = key.replace(/\/(page|route|layout)$/, '');
        // Drop the path entirely if any segment is a dynamic
        // placeholder — we'd be emitting a redirect for a route the
        // SSR Lambda has to canonicalize anyway.
        if (/\[.+?\]/.test(trimmed)) continue;
        if (trimmed === '' || trimmed === '/') continue;
        allPaths.add(trimmed);
      }
      
    } catch {
      // best-effort: same rationale as Source 1
    }
  }

  if (allPaths.size === 0) return;

  const ts = emitTrailingSlashRedirects(Array.from(allPaths), mode);
  if (ts.length === 0) return;
  const existing = manifest.redirects ?? [];
  // Append ALL trailing-slash redirects — no count cap. The KVS store/chunk
  // budget in buildKvsEntries is the authoritative limit (see comment above).
  manifest.redirects = [...existing, ...ts];
};

/**
 * One detected edge route, in the OpenNext config shape.
 *
 * `module` is the OpenNext route id (e.g. `app/api/edge/a/route`) —
 * leading `app/` or `pages/`, no extension. `pattern` is the URL pattern
 * with leading `/` (used as the CloudFront cache-behavior PathPattern).
 */
export type EdgeRoute = { module: string; pattern: string };

// Shape of the entries we care about in `.next/routes-manifest.json`. Both
// `redirects[]` and `headers[]` carry a `source` (Next route pattern) and
// a `regex` (compiled JS regex). Redirects also have a destination and
// statusCode; headers carry a list of {key, value} pairs.
type NextRoutesManifest = {
  redirects?: Array<{
    source: string;
    destination: string;
    statusCode: number;
    locale?: boolean;
    internal?: boolean;
    has?: unknown;
    missing?: unknown;
  }>;
  headers?: Array<{
    source: string;
    headers: Array<{ key: string; value: string }>;
    locale?: boolean;
    has?: unknown;
    missing?: unknown;
  }>;
  /**
   * Pages Router i18n config. Present when the user sets
   * `i18n: { locales: [...] }` in next.config; Next then rewrites every
   * `headers[]` / `redirects[]` source to start with
   * `/:nextInternalLocale(en|fr|...)/...`. The literal locale group is
   * not supported by CloudFront's PathPattern (no parens / pipes), so
   * unless we strip the prefix the rule never makes it past
   * `isSimpleNextSource` and the user's headers/redirects fall through
   * to OpenNext where security-named headers are silently dropped.
   */
  i18n?: { locales?: string[] };
};

/**
 * Pages Router i18n: when next.config sets `i18n: { locales }`, every
 * routes-manifest source gets prefixed with `/:nextInternalLocale(...)`.
 * That group blocks `isSimpleNextSource` because it carries `:` and
 * `(...)` syntax. Strip the locale group (if any) so the bare path can
 * be lifted to a CloudFront pattern. Leaves non-i18n sources untouched.
 */
export const stripNextInternalLocale = (source: string): string => {
  // Pattern Next emits is exactly `/:nextInternalLocale(<pipe-list>)`
  // followed by the rest of the URL. Match conservatively — if the
  // shape differs at all, leave the source alone so we don't misinterpret
  // it.
  const match = source.match(/^\/:nextInternalLocale\([a-zA-Z0-9_|-]+\)(.*)$/);
  if (!match) return source;
  const rest = match[1];
  // Resulting source must still start with `/`. When the original was
  // exactly `/:nextInternalLocale(...)` (the bare locale root), map it
  // to `/`.
  if (rest === '' || rest === '/') return '/';
  return rest.startsWith('/') ? rest : `/${rest}`;
};

/**
 * Test whether a Next.js route `source` is simple enough to lift to a
 * CloudFront Function / per-pattern ResponseHeadersPolicy. A source is
 * simple if it has no params (`:slug`, `:path+`), no regex groups, and
 * no character classes. Trailing-`*` is allowed because we map it to a
 * suffix-wildcard pattern handled by both the redirect snippet and
 * CloudFront's behavior matcher.
 *
 * Why so strict: the CloudFront Function redirect snippet only knows
 * exact-match and trailing-`*`. Anything else (param interpolation,
 * regex captures, locale groups) can't be evaluated at the edge — those
 * rules must stay in the OpenNext Lambda.
 */
const isSimpleNextSource = (source: string): boolean => {
  // Param syntax: ":name", ":name+", ":name*", or "(group)".
  if (/[:()]/.test(source)) return false;
  // Brackets, escapes, alternation, character classes.
  if (/[[\]\\|{}^$+?]/.test(source)) return false;
  // Only allow ASCII letters, digits, '/', '-', '_', '.', and a trailing '*'.
  // Strip the trailing '*' first if present.
  const stripped = source.endsWith('/*') ? source.slice(0, -2) : source;
  return /^\/[a-zA-Z0-9/_.-]*$/.test(stripped);
};

/**
 * Read `.next/routes-manifest.json` and lift simple redirects/headers
 * into the deploy manifest so the L3 wires them as CloudFront Functions
 * and per-pattern ResponseHeadersPolicies. Anything we don't lift stays
 * in the OpenNext Lambda; behavior is preserved either way.
 *
 * Skips silently when:
 *  - The manifest doesn't exist (e.g. `next build` hasn't run, or
 *    OpenNext is being driven from a pre-built `.next/`).
 *  - The redirect is `internal: true` (e.g. trailing-slash normalization;
 *    OpenNext handles it natively, and lifting it can flip-flop with
 *    Next's runtime URL handling).
 *  - The rule has `has`/`missing` conditions, locale groups, or any
 *    pattern feature the CloudFront edge can't evaluate.
 */
const applyLiftedRoutesManifest = (
  manifest: DeployManifest,
  projectDir: string,
): void => {
  const routesManifestPath = path.join(
    projectDir,
    '.next',
    'routes-manifest.json',
  );
  if (!fs.existsSync(routesManifestPath)) return;

  let routesManifest: NextRoutesManifest;
  try {
    routesManifest = JSON.parse(fs.readFileSync(routesManifestPath, 'utf-8'));
  } catch {
    // Invalid JSON — leave everything in Lambda. Don't fail the build.
    return;
  }

  const liftedRedirects: Redirect[] = [];
  const liftedHeaders: CustomHeader[] = [];
  let skippedRedirects = 0;
  let skippedHeaders = 0;

  // Pages Router with i18n rewrites every source/destination to start
  // with `/:nextInternalLocale(en|fr|...)`. The locale group is regex
  // syntax CloudFront PathPatterns can't match — without stripping it,
  // every rule falls through to OpenNext which silently drops
  // security-named headers (CloudFront refuses them in the customHeaders
  // array on the response).
  const hasI18nLocales = Boolean(routesManifest.i18n?.locales?.length);
  const normalizeSource = (s: string): string =>
    hasI18nLocales ? stripNextInternalLocale(s) : s;

  // Locale-strip can produce duplicate sources when the user's config
  // (or Next's manifest emit) contains both a bare and a locale-prefixed
  // form for the same path. Track which sources have already been lifted
  // so we can warn the user instead of silently last-wins. Same key
  // space for redirects and headers — they live in different lift
  // arrays, but a duplicate source within one type is the meaningful
  // collision.
  const seenRedirectSources = new Map<string, string>();
  const seenHeaderSources = new Map<string, string>();
  const collisions: string[] = [];

  for (const r of routesManifest.redirects ?? []) {
    if (r.internal) {
      // Trailing-slash and similar — leave to OpenNext.
      continue;
    }
    if (r.has || r.missing) {
      skippedRedirects++;
      continue;
    }
    if (![301, 302, 307, 308].includes(r.statusCode)) {
      skippedRedirects++;
      continue;
    }
    const source = normalizeSource(r.source);
    const destination = normalizeSource(r.destination);
    if (!isSimpleNextSource(source) || !isSimpleNextSource(destination)) {
      skippedRedirects++;
      continue;
    }
    const prior = seenRedirectSources.get(source);
    if (prior !== undefined && prior !== r.source) {
      collisions.push(
        `redirect source ${JSON.stringify(source)} appears in routes-manifest as both ${JSON.stringify(prior)} and ${JSON.stringify(r.source)} after locale strip; keeping the first`,
      );
      continue;
    }
    seenRedirectSources.set(source, r.source);
    liftedRedirects.push({
      source,
      destination,
      statusCode: r.statusCode as 301 | 302 | 307 | 308,
    });
  }

  for (const h of routesManifest.headers ?? []) {
    if (h.has || h.missing) {
      skippedHeaders++;
      continue;
    }
    const source = normalizeSource(h.source);
    if (!isSimpleNextSource(source)) {
      skippedHeaders++;
      continue;
    }
    const prior = seenHeaderSources.get(source);
    if (prior !== undefined && prior !== h.source) {
      collisions.push(
        `header source ${JSON.stringify(source)} appears in routes-manifest as both ${JSON.stringify(prior)} and ${JSON.stringify(h.source)} after locale strip; keeping the first`,
      );
      continue;
    }
    seenHeaderSources.set(source, h.source);
    const headers: Record<string, string> = {};
    for (const entry of h.headers) {
      if (entry.key.toLowerCase() === 'cache-control') {
        validateCacheControl(
          entry.value,
          `route ${source} (Next.js headers config)`,
        );
      }
      headers[entry.key] = entry.value;
    }
    liftedHeaders.push({
      source,
      headers,
    });
  }

  if (collisions.length > 0) {
    process.stderr.write(
      `⚠️  Next.js i18n locale-strip produced duplicate source patterns:\n` +
        collisions.map((c) => `   - ${c}\n`).join('') +
        `   Each conflicting rule's first occurrence wins. To resolve, ` +
        `disambiguate via has/missing conditions or remove redundant config entries.\n`,
    );
  }

  if (liftedRedirects.length > 0) {
    manifest.redirects = [...(manifest.redirects ?? []), ...liftedRedirects];
  }
  if (liftedHeaders.length > 0) {
    manifest.headers = [...(manifest.headers ?? []), ...liftedHeaders];
  }

  if (
    liftedRedirects.length > 0 ||
    liftedHeaders.length > 0 ||
    skippedRedirects > 0 ||
    skippedHeaders > 0
  ) {
    process.stdout.write(
      `🚀 Lifted ${liftedRedirects.length} redirect(s) and ${liftedHeaders.length} header rule(s) to CloudFront. ` +
        `${skippedRedirects + skippedHeaders} kept in Lambda (conditional/regex/locale).\n`,
    );
  }
};

/**
 * Detect edge routes by reading Next.js's compiled middleware-manifest.
 *
 * `next build` writes `.next/server/middleware-manifest.json` containing
 * one entry per route compiled with the edge runtime. The `name` field
 * is exactly the module path OpenNext expects in `functions.<n>.routes`,
 * and `matchers[0].originalSource` is the URL the route serves.
 *
 * Reading the manifest is the only reliable detection: a regex scan
 * matches false positives in comments and string literals; the user's
 * code may also re-export edge runtime via barrel files. Next's compiler
 * is the source of truth.
 *
 * Caller must run `next build` (we do, via runNextBuild) before this.
 * Returns an empty array when the manifest is missing or has no edge
 * functions — both cases are valid (no edge usage in the project).
 * @internal
 */
export const detectEdgeRoutes = (projectDir: string): EdgeRoute[] => {
  const manifestPath = path.join(
    projectDir,
    '.next',
    'server',
    'middleware-manifest.json',
  );
  let manifest: {
    functions?: Record<
      string,
      {
        name?: string;
        matchers?: { originalSource?: string }[];
      }
    >;
  };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const fns = manifest.functions ?? {};
  const out: EdgeRoute[] = [];
  for (const fn of Object.values(fns)) {
    const moduleName = fn.name;
    if (!moduleName) continue;
    // Iterate every matcher — multi-matcher middleware
    // (e.g. matcher: ['/admin/:path*', '/api/admin/:path*']) loses every
    // matcher after the first if we only honor matchers[0].
    for (const matcher of fn.matchers ?? []) {
      const original = matcher.originalSource;
      if (!original) continue;
      const slashed = original.startsWith('/') ? original : `/${original}`;
      out.push({
        module: moduleName,
        // OpenNext docs require CloudFront-compatible patterns in
        // functions.<n>.patterns; same translation as the route mapper.
        pattern: nextPatternToCloudFront(slashed),
      });
    }
  }
  return out;
};

/**
 * Strip JS line + block comments + string literals from source so a
 * subsequent token scan sees only executable code. Without this, a
 * `// TODO: switch to aws-apigw-v1` comment would falsely satisfy the
 * presence check, and a string like `const NOTE = 'aws-apigw-v1'` in
 * an unrelated context would too.
 *
 * We replace strings with empty quotes (preserving outer structure) so
 * the resulting source still parses for our anchored regex matches —
 * those expect to find the override values *inside* `'...'` or `"..."`.
 * Therefore we apply a *separate* pass that preserves only the relevant
 * key:value pairs (see `findOverride`).
 */
const stripCommentsForScan = (source: string): string => {
  // Block comments first (greedy multi-line), then line comments. Order
  // matters because a `//` inside a `/* ... */` should not be treated as
  // a line comment.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
};

/**
 * Look for a `<key>: '<value>'` (or double-quoted) pair anywhere in the
 * given source. We don't try to anchor to a specific block (`default:`
 * vs `functions.x:`) because OpenNext config shapes vary — a `default`
 * section may live inline, behind a `withApiGw()` helper, or composed
 * from imported constants. The narrower check would generate too many
 * false negatives.
 *
 * We accept the override as "present" when:
 *   - the key:value pair appears literally, OR
 *   - the value appears as a literal string anywhere in the file
 *     (covers helper-imported configs and `as const` references).
 *
 * Combined with comment stripping, this catches the realistic configs
 * customers write while rejecting the obvious miss-types.
 */
const findOverride = (source: string, key: string, value: string): boolean => {
  // Direct key:value.
  const kv = new RegExp(`\\b${key}\\s*:\\s*['"\`]${escapeRegex(value)}['"\`]`);
  if (kv.test(source)) return true;
  // Bare-value reference (helper-imported / re-exported constant).
  const bare = new RegExp(`['"\`]${escapeRegex(value)}['"\`]`);
  return bare.test(source);
};

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Inspect a user-authored `open-next.config.ts` for the converter/wrapper
 * overrides that the L3's API-Gateway-fronted SSR Lambda requires.
 *
 * The L3 fronts SSR with API Gateway REST + STREAM mode (B22/B23/B24
 * cluster). REST sends payload v1; OpenNext defaults to v2. Without
 * `converter: 'aws-apigw-v1'` every URL renders as `/`. Without
 * `wrapper: 'aws-lambda-streaming'` POST/PUT bodies are silently dropped.
 *
 * When edge routes are detected, the user's config must also declare a
 * separate edge function — OpenNext refuses to build a project that
 * declares `runtime = 'edge'` without an explicit split function.
 *
 * Why textual scan: the file is TypeScript that may be transpiled at
 * build time; importing it here would require running the TS compiler
 * before OpenNext even starts. We strip comments + look for either a
 * `<key>: '<value>'` pair OR a bare `'<value>'` reference (covers
 * helper-imported configs); with the comment strip + anchored regex,
 * substring false-positives from comments and false-negatives from
 * imported constants are addressed.
 */
const validateUserOpenNextConfig = (
  configFile: string,
  edgeRoutes: EdgeRoute[] = [],
): void => {
  let raw: string;
  try {
    raw = fs.readFileSync(configFile, 'utf-8');
  } catch (err) {
    throw new HostingError(
      'OpenNextConfigUnreadableError',
      {
        message: `Found ${configFile} but could not read it.`,
        resolution:
          'Ensure the file is readable, or remove it to let the adapter generate the required config.',
      },
      err as Error,
    );
  }
  const source = stripCommentsForScan(raw);
  const missing: string[] = [];
  if (!findOverride(source, 'converter', 'aws-apigw-v1')) {
    missing.push("converter: 'aws-apigw-v1'");
  }
  // Accept either the patched community wrapper (`aws-lambda-streaming`) or
  // OpenNext's native API Gateway streaming wrapper (`aws-apigw-streaming`,
  // the upstream PR). Both produce a handler compatible with the REST API
  // STREAM integration; rejecting the native one would force users onto the
  // wrapper we monkeypatch even after upstream ships the proper fix.
  const hasStreamingWrapper =
    findOverride(source, 'wrapper', 'aws-lambda-streaming') ||
    findOverride(source, 'wrapper', 'aws-apigw-streaming');
  if (!hasStreamingWrapper) {
    missing.push("wrapper: 'aws-lambda-streaming' (or 'aws-apigw-streaming')");
  }
  // Edge functions must be split out per OpenNext's build-time
  // requirement. Detect by checking for any `runtime: 'edge'` token in
  // the user's config when edgeRoutes were detected from the user's
  // source tree.
  const needsEdgeBlock = edgeRoutes.length > 0;
  const hasEdgeBlock = /\bruntime\s*:\s*['"`]edge['"`]/.test(source);
  if (needsEdgeBlock && !hasEdgeBlock) {
    missing.push(
      "functions: { edge: { runtime: 'edge', placement: 'global', routes: [...] } }",
    );
  }
  if (missing.length === 0) return;
  throw new HostingError('IncompatibleOpenNextConfigError', {
    message: `Found ${configFile}, but it is missing the override(s) the hosting Lambda runtime requires: ${missing.join(', ')}.`,
    resolution:
      'Either delete open-next.config.ts to let the adapter generate one, or add the missing override(s) to your config. Without them: payload v1/v2 mismatch renders every URL as "/", or POST/PUT bodies are silently dropped (response_stream wrapper).',
  });
};

/**
 * Generate <projectDir>/open-next.config.ts with `aws-apigw-v1` + streaming
 * wrapper so OpenNext picks them up on its next build. Returns a cleanup
 * closure. No-ops if the user already has their own open-next.config.ts.
 *
 * When `edgeRoutes` is non-empty, also emits a `functions.edge` block that
 * tells OpenNext to bundle those routes into a separate Lambda@Edge
 * function. Without that block OpenNext refuses to build any project that
 * declares `runtime = 'edge'` — it errors with "OpenNext requires edge
 * runtime function to be defined in a separate function" mid-bundle, so
 * the auto-config has to declare the split function up front.
 */
const installGeneratedOpenNextConfig = (
  projectDir: string,
  edgeRoutes: EdgeRoute[] = [],
): (() => void) => {
  const configFile = path.join(projectDir, 'open-next.config.ts');
  const edgeBlock = renderEdgeFunctionsBlock(edgeRoutes);
  // `minify: true` shrinks the SSR Lambda bundle ~30-50% (esbuild flags
  // unminified bundles >5MB with a scary "⚠️" — the AWS Blocks bug-bash
  // saw 34-35 MB and 19/20 testers thought the build was failing). The
  // semantically-equivalent fix would be externalizing `@aws-sdk/*`
  // (Lambda runtime ships AWS SDK v3), but OpenNext does not yet expose
  // an `external` knob in its public config.
  const configBody = `// AUTO-GENERATED by @aws-blocks/hosting — do not edit.
const config = {
  default: {
    minify: true,
    override: {
      converter: 'aws-apigw-v1',
      wrapper: 'aws-lambda-streaming',
    },
  },${edgeBlock}
};
export default config;
`;
  // wx = write exclusively; throws EEXIST atomically if the file is already
  // there. Avoids a TOCTOU between an existsSync check and the write.
  try {
    fs.writeFileSync(configFile, configBody, {
      encoding: 'utf-8',
      flag: 'wx',
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      validateUserOpenNextConfig(configFile, edgeRoutes);
      return () => undefined;
    }
    throw err;
  }
  if (edgeRoutes.length > 0) {
    process.stderr.write(
      `\u{1F4DD} Generated open-next.config.ts with edge function for: ${edgeRoutes
        .map((r) => r.pattern || '/')
        .join(', ')}\n`,
    );
  }
  return () => {
    // best-effort cleanup; ignore if the file is gone or cannot be removed.
    try {
      fs.rmSync(configFile, { force: true });
      
    } catch {
      // intentional
    }
  };
};

/**
 * Build the `functions: { edge1: {...}, edge2: {...} }` snippet (with a
 * leading comma) for inclusion in the generated open-next.config.ts.
 * Empty string when the project has no edge routes.
 *
 * OpenNext's `generateEdgeBundle` enforces one route per function entry —
 * passing two routes throws `"Only one function is supported for now"`.
 * So we emit one `edgeN` entry per detected route instead of bundling
 * them all under one `edge` key.
 *
 * Patterns are CloudFront cache-behavior patterns and require a leading
 * slash (per the SplittedFunctionOptions.patterns JSDoc in OpenNext:
 * "Cloudfront compatible patterns. i.e. /api/*"). The detection code
 * stores them slash-less for ergonomics, so we prepend here.
 *
 * Per OpenNext docs, `placement: 'global'` deploys to Lambda@Edge in
 * us-east-1 and replicates to CloudFront PoPs. The Lambda@Edge converter
 * (`aws-cloudfront`) reads CloudFront origin-request events directly —
 * no API Gateway in front, so the body-hash 403 issue doesn't apply
 * here (Lambda@Edge invocation isn't OAC-signed by CloudFront).
 */
const renderEdgeFunctionsBlock = (edgeRoutes: EdgeRoute[]): string => {
  if (edgeRoutes.length === 0) return '';
  // Escape backslashes first (so the slash inserted by quote-escape isn't
  // itself doubled), then escape single quotes. Without this CodeQL flags
  // the encoder as incomplete — a route module path containing `\` would
  // emit invalid JS into the generated open-next.config.ts.
  const quote = (s: string) =>
    `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const entries = edgeRoutes
    .map(
      (route, i) => `    edge${i + 1}: {
      runtime: 'edge',
      placement: 'global',
      override: {
        converter: 'aws-cloudfront',
        wrapper: 'aws-lambda',
      },
      routes: [${quote(route.module)}],
      patterns: [${quote(route.pattern)}],
    },`,
    )
    .join('\n');
  return `
  functions: {
${entries}
  },`;
};

/**
 * Range of `@opennextjs/aws` versions whose internals
 * (`patchStreamingWrapperForApiGateway` + `patchEdgeBundlesForLambdaEdge`)
 * we've explicitly verified. New OpenNext releases land regularly; we
 * don't fail the build on out-of-range — the patcher itself throws
 * `UpstreamPatchPatternChangedError` when it can't find the signatures
 * — but a stderr warning here makes the cause obvious *before* the
 * patcher fires.
 *
 * Bump the upper bound once a new OpenNext version is verified (run
 * the integration deploy + the brittleness-gating tests against it).
 */
// Exported so the X.1 cross-adapter version-pin test can reach it
// without dynamic imports / scraping. Bump together with the actual
// verification work.
export const VERIFIED_OPENNEXT_RANGE = '>=3.10.0 <3.11.0';

/**
 * Read the installed `@opennextjs/aws` version from the project's
 * node_modules and emit a stderr warning when it falls outside the
 * range we've explicitly verified. Best-effort: silent when the package
 * isn't installed (the L3 path may legitimately run with a pre-built
 * `.open-next/`) or when the version can't be parsed.
 */
const warnIfOpenNextOutOfRange = (projectDir: string): void => {
  const info = getPackageInfoSync('@opennextjs/aws', { paths: [projectDir] });
  const version = info?.version;
  if (!version || !semver.valid(version)) return;
  if (semver.satisfies(version, VERIFIED_OPENNEXT_RANGE)) return;
  process.stderr.write(
    `⚠️  @opennextjs/aws@${version} is outside the version range this adapter was verified against (${VERIFIED_OPENNEXT_RANGE}). ` +
      `If the streaming-wrapper or edge-bundle patcher errors with UpstreamPatchPatternChangedError, that's the most likely cause — pin to a verified version or file an issue with the OpenNext release notes.\n`,
  );
};

/**
 * Patch OpenNext's bundled `aws-lambda-streaming` wrapper for API Gateway
 * STREAM framing. Two changes to <projectDir>/.open-next/server-functions/
 * default/index.mjs:
 *   1. Drop the `setContentType("application/vnd.awslambda.http-integration-
 *      response")` call — that's the Function URL streaming marker; API
 *      Gateway leaks it into the wire response and breaks HTTP/2 framing.
 *   2. Force the wrapper's identity branch (skip brotli/gzip/deflate);
 *      CloudFront handles compression downstream.
 * Idempotent.
 * @internal
 */
export const patchStreamingWrapperForApiGateway = (
  openNextDir: string,
): void => {
  const root = path.join(openNextDir, 'server-functions', 'default');
  // OpenNext puts the streaming wrapper in `default/index.mjs` for flat
  // packages, but in workspace setups it nests the real bundle under
  // `default/<workspace-path>/index.mjs` and emits a 60-byte re-export
  // at `default/index.mjs`. Match every index.mjs in the tree (skipping
  // node_modules — the bundler embeds OpenNext inline) and patch the
  // ones that contain the wrapper signature.
  if (!fs.existsSync(root)) return;
  const candidates = fg.sync('**/index.mjs', {
    cwd: root,
    absolute: true,
    ignore: ['**/node_modules/**'],
  });

  let totalPatches = 0;
  let filesPatched = 0;
  for (const bundle of candidates) {
    let src: string;
    try {
      src = fs.readFileSync(bundle, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    let patches = 0;

    const setContentTypeRe =
      /[A-Za-z_$][\w$]*\.setContentType\("application\/vnd\.awslambda\.http-integration-response"\)/g;
    if (setContentTypeRe.test(src)) {
      src = src.replace(setContentTypeRe, 'void 0');
      patches++;
    }

    // The wrapper does:
    //   if (acceptEncoding.includes("br")) { ... brotli ... }
    //   else if (acceptEncoding.includes("gzip")) { ... gzip ... }
    //   else if (acceptEncoding.includes("deflate")) { ... deflate ... }
    //   else { identity }
    // Force the identity branch by neutering all three checks.
    for (const algo of ['br', 'gzip', 'deflate']) {
      const re = new RegExp(`\\.includes\\("${algo}"\\)`, 'g');
      if (re.test(src)) {
        src = src.replace(re, `.includes("__hosting_no_${algo}__")`);
        patches++;
      }
    }

    if (patches > 0) {
      fs.writeFileSync(bundle, src, 'utf-8');
      totalPatches += patches;
      filesPatched++;
    }
  }

  if (filesPatched === 0) {
    if (process.env.HOSTING_LENIENT_PATCHES === '1') {
      process.stderr.write(
        `⚠️  Streaming-wrapper patch found nothing to change under ${root}. ` +
          `Continuing because HOSTING_LENIENT_PATCHES=1 is set.\n`,
      );
      return;
    }
    throw new HostingError('UpstreamPatchPatternChangedError', {
      message:
        `Streaming-wrapper patch found nothing to change under ${root}. ` +
        'OpenNext likely changed its bundled aws-lambda-streaming wrapper.',
      resolution:
        'File an issue with the OpenNext version and the regex name (`patchStreamingWrapperForApiGateway`). ' +
        'To bypass while investigating, set HOSTING_LENIENT_PATCHES=1 — note that streaming responses may be malformed without the patch.',
    });
  }

  process.stderr.write(
    `\u{1F527} Patched bundled aws-lambda-streaming wrapper for API Gateway STREAM ` +
      `(${totalPatches} edits across ${filesPatched} file${filesPatched > 1 ? 's' : ''}).\n`,
  );
};

/**
 * Patch every OpenNext edge bundle so it runs on Lambda@Edge nodejs20.x.
 *
 * OpenNext prepends each edge bundle with `import * as process from "node:process";`
 * (banner injected by createEdgeBundle.ts). Under Node 20 ESM the resulting
 * Module namespace's `env` binding is non-writable. The next-emitted Next.js
 * shim then runs `process.env = e.g.process.env` and crashes with:
 *
 * TypeError: Cannot assign to read only property 'env' of object '[object Module]'
 *
 * Replace the namespace import with a default import so `process` is the
 * live mutable singleton (default export of `node:process`). Idempotent —
 * re-running on an already-patched file finds no banner to swap.
 *
 * Affects only edge functions (Lambda@Edge); the regional `default` bundle
 * uses a different banner and is unaffected.
 * @internal
 */
const EDGE_PROCESS_BANNER = /^import \* as process from "node:process";/m;
const EDGE_PROCESS_BANNER_REPLACEMENT =
  'const process = (await import("node:process")).default;';

/**
 * Apply the {@link EDGE_PROCESS_BANNER} swap to every edge bundle under
 * `<openNextDir>/server-functions/edge*\/index.mjs`. Throws
 * `UpstreamPatchPatternChangedError` when bundles exist but none match the
 * banner (use `HOSTING_LENIENT_PATCHES=1` to revert to a warning).
 * @internal
 */
export const patchEdgeBundlesForLambdaEdge = (openNextDir: string): void => {
  const serverFnDir = path.join(openNextDir, 'server-functions');
  if (!fs.existsSync(serverFnDir)) return;
  const bundles = fg.sync('edge*/index.mjs', {
    cwd: serverFnDir,
    absolute: true,
  });
  if (bundles.length === 0) return;

  let total = 0;
  for (const bundle of bundles) {
    const src = fs.readFileSync(bundle, 'utf-8');
    if (!EDGE_PROCESS_BANNER.test(src)) continue;
    fs.writeFileSync(
      bundle,
      src.replace(EDGE_PROCESS_BANNER, EDGE_PROCESS_BANNER_REPLACEMENT),
      'utf-8',
    );
    total++;
  }
  if (total === 0) {
    if (process.env.HOSTING_LENIENT_PATCHES === '1') {
      process.stderr.write(
        `⚠️  Edge-bundle banner patch matched none of ${bundles.length} edge bundle(s). ` +
          `Continuing because HOSTING_LENIENT_PATCHES=1 is set.\n`,
      );
      return;
    }
    throw new HostingError('UpstreamPatchPatternChangedError', {
      message:
        `Edge-bundle banner patch matched none of ${bundles.length} edge bundle(s) under ${serverFnDir}. ` +
        'OpenNext likely changed the process import banner injected into edge bundles.',
      resolution:
        'File an issue with the OpenNext version and the regex name (`patchEdgeBundlesForLambdaEdge`). ' +
        'To bypass while investigating, set HOSTING_LENIENT_PATCHES=1 — Lambda@Edge cold starts may crash without the patch.',
    });
  }
  process.stderr.write(
    `\u{1F527} Patched ${total} edge bundle(s) for Lambda@Edge nodejs20.x compatibility.\n`,
  );
};

/**
 * Patch the OpenNext image-optimization bundle for the Next.js 15.5 image
 * optimizer signature change.
 *
 * Next 15.5 inserted a `maximumResponseBody` parameter into
 * `fetchInternalImage`:
 *   - was: `fetchInternalImage(href, _req, _res, handleRequest)`
 *   - now: `fetchInternalImage(href, _req, _res, maximumResponseBody, handleRequest)`
 *
 * `@opennextjs/aws` (≤3.10.x) still calls it with FOUR args
 * (`fetchInternalImage(n, {headers:e}, {}, handleRequest)`), so on Next 15.5
 * the `handleRequest` callback lands in the `maximumResponseBody` slot and the
 * real 5th arg is `undefined`. At runtime the optimizer throws
 * `TypeError: <handler> is not a function` for every LOCAL image → 500.
 *
 * Fix: insert an explicit `void 0` for `maximumResponseBody` so the handler
 * shifts into the 5th position. Match the structural minified shape
 * `fetchInternalImage)(<a>,{headers:<b>},{},<c>)` (variable names are unstable
 * across builds) and rewrite the trailing `,<c>)` → `,void 0,<c>)`. Idempotent:
 * a call that already has `,{},void 0,` is left alone.
 * @internal
 */
export const patchImageOptimizerForNext155 = (openNextDir: string): void => {
  const root = path.join(openNextDir, 'image-optimization-function');
  if (!fs.existsSync(root)) return; // image optimization disabled for this app
  const candidates = fg.sync('**/index.mjs', {
    cwd: root,
    absolute: true,
    ignore: ['**/node_modules/**'],
  });

  // fetchInternalImage)( <arg> , { headers : <arg> } , {} , <arg> )
  // Capture the leading args up to the empty `{}` res object, then the handler.
  const callRe =
    /(fetchInternalImage\)\(\s*[^,]+,\s*\{\s*headers\s*:\s*[^}]+\}\s*,\s*\{\s*\}\s*,\s*)([^),]+)\)/g;

  let filesPatched = 0;
  for (const bundle of candidates) {
    let src: string;
    try {
      src = fs.readFileSync(bundle, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    // Idempotency: skip if the handler already sits in the 5th slot.
    if (/fetchInternalImage\)\([^)]*\}\s*,\s*void 0\s*,/.test(src)) continue;
    if (!callRe.test(src)) continue;
    callRe.lastIndex = 0;
    const next = src.replace(callRe, '$1void 0,$2)');
    if (next !== src) {
      fs.writeFileSync(bundle, next, 'utf-8');
      filesPatched++;
    }
  }

  if (filesPatched === 0) {
    // Not fatal: the app may be on a Next version whose signature still matches
    // OpenNext's call, or OpenNext may have already adapted. Warn so a future
    // signature drift is visible, but don't block the build.
    process.stderr.write(
      `⚠️  image-optimizer patch (Next 15.5 fetchInternalImage arity) found ` +
        `nothing to change under ${root}. If local-image optimization 500s with ` +
        `"is not a function", the OpenNext/Next signatures changed again ` +
        `(see patchImageOptimizerForNext155).\n`,
    );
    return;
  }

  process.stderr.write(
    `\u{1F527} Patched image-optimization bundle for Next.js 15.5 fetchInternalImage ` +
      `signature (${filesPatched} file${filesPatched > 1 ? 's' : ''}).\n`,
  );
};

/**
 * Ensure the OpenNext image-optimization Lambda has a **linux-x64** `sharp`
 * native binary.
 *
 * The image optimizer needs sharp to resize/transcode. OpenNext bundles
 * whatever `sharp` is in the dev `node_modules`, which on a macOS build host is
 * `sharp-darwin-arm64` — that binary can't load on the linux-x64 Lambda, so
 * Next's optimizer silently falls back to `unoptimized` passthrough: every
 * request returns the ORIGINAL bytes (200, but no resize, no webp/avif). Visible
 * as `/_next/image?...&w=64` returning the full-size source `image/png`.
 *
 * Fix: install `sharp` into the image-optimization-function bundle forcing the
 * Lambda's platform (`--os=linux --cpu=x64 --libc=glibc`), matching the Nitro
 * adapter's IPX bundle. Mirrors `buildImageOptBundleIfNeeded` in nitro.ts.
 *
 * Best-effort + idempotent: skips when the image fn dir is absent (image
 * optimization disabled) or a linux sharp is already present; warns (not fatal)
 * if the install fails, since the crash-level bug is already fixed and the app
 * still serves originals.
 * @internal
 */
export const installLinuxSharpForImageOptimizer = (
  openNextDir: string,
): void => {
  const imgDir = path.join(openNextDir, 'image-optimization-function');
  if (!fs.existsSync(imgDir)) return; // image optimization disabled

  // Already has a linux sharp binary? (idempotent — avoid reinstalling.)
  const linuxSharp = fg.sync(
    'node_modules/@img/sharp-linux*/**/*.node',
    { cwd: imgDir, absolute: true },
  );
  const linuxSharpLegacy = fg.sync(
    'node_modules/sharp/**/linux-x64*/**/*.node',
    { cwd: imgDir, absolute: true },
  );
  if (linuxSharp.length > 0 || linuxSharpLegacy.length > 0) return;

  // Pin a MODERN sharp (>=0.33). The `--os/--cpu/--libc` cross-install flags
  // (which fetch the `@img/sharp-linux-x64` prebuilt) only exist on sharp
  // 0.33+. OpenNext historically bundles sharp 0.32.6, whose darwin prebuilt
  // sits in `node_modules/sharp/build/Release/*.node` and is NOT replaced by
  // those flags (0.32 used `prebuild-install`/SHARP_* env, not npm os/cpu) —
  // so reinstalling `^0.32` would leave the darwin binary in place and the
  // optimizer would keep serving unoptimized originals. Force 0.34.x.
  const SHARP_RANGE = '^0.34.0';
  const sharpDir = path.join(imgDir, 'node_modules', 'sharp');
  // Remove the wrong-platform / old bundled sharp so the reinstall is clean and
  // the fresh linux binary is unambiguously what loads at runtime.
  if (fs.existsSync(sharpDir)) {
    try {
      fs.rmSync(sharpDir, { recursive: true, force: true });
    } catch {
      /* best-effort — npm install below still overwrites */
    }
  }
  const sharpVersion = SHARP_RANGE;

  // Minimal package.json so `npm install` only pulls sharp (+ its platform
  // optionalDependencies), not the whole app tree.
  const pkgJsonPath = path.join(imgDir, 'package.json');
  let restorePkgJson: string | undefined;
  try {
    if (fs.existsSync(pkgJsonPath)) {
      restorePkgJson = fs.readFileSync(pkgJsonPath, 'utf-8');
    }
    fs.writeFileSync(
      pkgJsonPath,
      JSON.stringify(
        { name: 'image-optimization-function', private: true, dependencies: { sharp: sharpVersion } },
        null,
        2,
      ),
      'utf-8',
    );

    process.stderr.write(
      '\u{1F4F8} Installing sharp (linux-x64) into the image-optimization Lambda bundle\n',
    );
    spawn.sync(
      'npm',
      [
        'install',
        '--no-audit',
        '--no-fund',
        '--silent',
        '--include=optional',
        '--omit=dev',
        '--os=linux',
        '--cpu=x64',
        '--libc=glibc',
      ],
      { cwd: imgDir, stdio: 'inherit' },
    );
  } catch (error) {
    // Restore the original package.json (if any) so we don't leave a stray file.
    if (restorePkgJson !== undefined) {
      try {
        fs.writeFileSync(pkgJsonPath, restorePkgJson, 'utf-8');
      } catch {
        /* best-effort */
      }
    }
    process.stderr.write(
      `⚠️  Could not install linux-x64 sharp into the image-optimization Lambda ` +
        `(${(error as Error).message}). The optimizer will serve UNOPTIMIZED ` +
        `originals (200, full size) until sharp's linux binary is present.\n`,
    );
  }
};

/**
 * Check whether `.next/server/middleware-manifest.json` already exists.
 *
 * The user's CI (or a previous deploy) may have already produced this
 * manifest. When present, we can read edge routes directly without
 * spending another `next build` cycle.
 *
 * Exported for unit testing.
 * @internal
 */
export const hasExistingMiddlewareManifest = (projectDir: string): boolean => {
  return fs.existsSync(
    path.join(projectDir, '.next', 'server', 'middleware-manifest.json'),
  );
};

/**
 * Source-scan the project for files declaring `runtime: 'edge'` (or
 * `'experimental-edge'`).
 *
 * Returns true if any user file looks like an edge-runtime route, false
 * if none. False-positives are acceptable (we'd just rebuild as before);
 * false-negatives must be avoided (we'd skip the build but OpenNext
 * would then refuse to bundle the route).
 *
 * The scan is conservative: a single regex match anywhere in any
 * `.ts/.tsx/.js/.jsx` under `app/`, `src/app/`, `pages/`, or `src/pages/`
 * triggers a true return. Comments and strings are not excluded — that's
 * fine since the cost of a false-positive is a rebuild we'd otherwise
 * have run anyway.
 *
 * Exported for unit testing.
 * @internal
 */
export const projectHasEdgeRuntimeRoutes = (projectDir: string): boolean => {
  const roots = ['app', 'src/app', 'pages', 'src/pages'].filter((d) =>
    fs.existsSync(path.join(projectDir, d)),
  );
  if (roots.length === 0) return false;
  const pattern = /runtime\s*[:=]\s*['"`](?:edge|experimental-edge)['"`]/;
  const files = fg.sync(
    roots.map((r) => `${r}/**/*.{ts,tsx,js,jsx,mjs}`),
    { cwd: projectDir, absolute: true, ignore: ['**/node_modules/**'] },
  );
  for (const file of files) {
    try {
      if (pattern.test(fs.readFileSync(file, 'utf-8'))) return true;
    } catch {
      continue;
    }
  }
  return false;
};

/**
 * Execute `next build` from the project directory so that the
 * .next/server/middleware-manifest.json (which lists every edge function
 * Next compiled) exists before we generate `open-next.config.ts`.
 *
 * OpenNext re-runs `next build` later — Next's `.next/cache` makes that
 * second invocation cheap (typically <10s when nothing changed).
 *
 * The build is delegated to the user's `npm run build` script so any
 * project-specific env / pre-build steps are honored.
 */
const runNextBuild = (projectDir: string): void => {
  process.stderr.write(`\u{1F528} Running next build (for edge detection)\n`);
  try {
    spawn.sync('npm', ['run', 'build'], {
      cwd: projectDir,
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
  } catch (error) {
    throw new HostingError(
      'NextBuildError',
      {
        message: 'next build failed (running from npm run build).',
        resolution:
          'Run `npm run build` manually in your project to see the failure. ' +
          'Once it builds locally, re-run the deploy.',
      },
      error as Error,
    );
  }
};

/**
 * Execute the OpenNext build command.
 *
 * Runs `npx @opennextjs/aws build` from the project directory. The consumer
 * project must have @opennextjs/aws installed as a devDependency — this avoids
 * bloating the hosting package for SPA/static users who don't need OpenNext.
 *
 * If @opennextjs/aws is not installed, npx will fail with a clear error.
 * We catch it and provide an actionable resolution message.
 */
const runOpenNextBuild = (projectDir: string, configPath?: string): void => {
  const args = ['@opennextjs/aws', 'build'];
  if (configPath) args.push('--config-path', configPath);

  process.stderr.write(
    `\u{1F528} Running OpenNext build: npx ${args.join(' ')}\n`,
  );
  // OpenNext emits a stderr line that reads as a fatal error during this
  // build:
  //   ERROR Wrapper aws-lambda-streaming and converter aws-apigw-v1 are not compatible.
  //   For the wrapper aws-lambda-streaming you should only use the following converters: aws-apigw-v2.
  // It is not fatal — the hosting stack fronts the SSR Lambda with API Gateway
  // v1 (REST API) for `response-streaming-invocations`, and the bundle is
  // patched after this build finishes (see `patchStreamingWrapperForApiGateway`).
  // Pre-announce so users running `ampx deploy` for the first time don't think
  // OpenNext failed.
  process.stderr.write(
    `\u{2139}\u{FE0F}  OpenNext may print "Wrapper aws-lambda-streaming and converter aws-apigw-v1 are not compatible" — this is expected. The hosting stack fronts the SSR Lambda with API Gateway v1 (REST API) and patches the bundled streaming wrapper after the build.\n`,
  );

  // Clear .open-next build output before OpenNext regenerates it.
  // This prevents esbuild errors from stale artifacts when the Next.js app
  // has changed (e.g., deleted files still referenced in old bundles).
  const openNextOutputDir = path.join(projectDir, '.open-next');
  if (fs.existsSync(openNextOutputDir)) {
    fs.rmSync(openNextOutputDir, { recursive: true, force: true });
  }

  try {
    spawn.sync('npx', args, {
      cwd: projectDir,
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
  } catch (error) {
    // Check if the error is because @opennextjs/aws is not installed
    const errMsg = (error as Error).message || '';
    if (
      errMsg.includes('not found') ||
      errMsg.includes('ERR_MODULE_NOT_FOUND') ||
      errMsg.includes('Cannot find package')
    ) {
      throw new HostingError(
        'OpenNextNotFoundError',
        {
          message:
            '@opennextjs/aws is not installed. Next.js hosting requires OpenNext to build and deploy your app.',
          resolution:
            "Add @opennextjs/aws to your project's devDependencies:\n\n" +
            '  npm install --save-dev @opennextjs/aws\n\n' +
            'Then re-run your deployment.',
        },
        error as Error,
      );
    }

    throw new HostingError(
      'OpenNextBuildError',
      {
        message: 'OpenNext build failed.',
        resolution:
          'Check the build output above for errors. Common issues:\n' +
          '  - Missing Next.js dependencies (run: npm install)\n' +
          '  - Invalid next.config.js\n' +
          '  - TypeScript compilation errors in your app\n' +
          '  - Missing .next/ directory (run: next build)',
      },
      error as Error,
    );
  }
};

/**
 * Translate OpenNext output structure into our framework-agnostic DeployManifest.
 */
const translateOpenNextOutput = (
  output: OpenNextOutput,
  openNextDir: string,
): DeployManifest => {
  const manifest: DeployManifest = {
    version: 1,
    compute: {},
    staticAssets: {
      directory: path.join(openNextDir, 'assets'),
      // Next.js content-hashes everything under `_next/static`; HTML and
      // public/ live elsewhere in the assets dir and must NOT be marked
      // immutable (would brick clients on redeploy — see L3 PWA note).
      immutablePaths: ['_next/static/*'],
    },
    routes: [],
  };

  // Map server functions (origins) to compute resources
  if (output.origins) {
    for (const [name, origin] of Object.entries(output.origins)) {
      // Skip S3 origin and imageOptimizer (handled separately via manifest.imageOptimization)
      if (name === 's3' || name === 'imageOptimizer') continue;

      const computeResource = mapOriginToCompute(name, origin, openNextDir);
      if (computeResource) {
        manifest.compute[name] = computeResource;
      }
    }
  }

  // Edge functions (Lambda@Edge bundles, one per route) live under
  // `edgeFunctions` in OpenNext's output, separate from `origins` because
  // they don't have an HTTP origin endpoint — CloudFront associates them
  // directly with cache behaviors. Translate each to a compute resource of
  // `type: 'edge'` so the L3 construct can build them with
  // `experimental.EdgeFunction` and attach as edgeLambdas on the matching
  // behavior.
  if (output.edgeFunctions) {
    for (const [name, fn] of Object.entries(output.edgeFunctions)) {
      // OpenNext writes `bundle: ".open-next/functions/<name>"` in the
      // output manifest but the actual edge bundle is emitted under
      // `.open-next/server-functions/<name>`. Probe the disk and pick
      // whichever path actually exists.
      const candidates = [
        fn.bundle
          ? path.resolve(path.dirname(openNextDir), fn.bundle)
          : path.join(openNextDir, 'functions', name),
        path.join(openNextDir, 'server-functions', name),
        path.join(openNextDir, 'functions', name),
      ];
      const bundle = candidates.find((p) => fs.existsSync(p)) ?? candidates[0];

      manifest.compute[name] = {
        type: 'edge',
        bundle,
        handler: fn.handler ?? 'index.handler',
        placement: 'global',
        streaming: false,
        runtime: 'nodejs20.x',
      };
    }
  }

  // Map behaviors to routes
  if (output.behaviors) {
    manifest.routes = mapBehaviorsToRoutes(output.behaviors);
  }

  // ISR/Cache detection — only provision cache infra if ISR is actually used.
  // Evidence: revalidation-function exists OR cache handler dir exists in output.
  if (output.additionalProps?.disableIncrementalCache !== true) {
    const revalidationFnDir = path.join(openNextDir, 'revalidation-function');
    const hasRevalidationFn = fs.existsSync(revalidationFnDir);
    const cacheDir = path.join(openNextDir, 'cache');
    const hasCacheDir = fs.existsSync(cacheDir);
    const hasIsrEvidence = hasRevalidationFn || hasCacheDir;

    if (hasIsrEvidence) {
      const computeNames = Object.keys(manifest.compute);
      const primaryComputeName =
        computeNames.find((n) => n === 'default' || n === 'server') ??
        computeNames[0];
      if (primaryComputeName) {
        // Seed the cache bucket with the build's prebuilt ISR/SSG cache
        // (.open-next/cache) so prerendered pages are a cache HIT on the
        // first request instead of a cold on-demand render. The on-disk
        // layout is already `<buildId>/<route>.cache`, which matches what
        // the runtime reads (CACHE_BUCKET_KEY_PREFIX is empty + keys are
        // namespaced by OPEN_NEXT_BUILD_ID).
        const seedDirectory = hasCacheDir ? cacheDir : undefined;

        // Honor OpenNext's `disableTagCache`: when set, the user opted out of
        // the DynamoDB tag table (keeping only the S3 incremental cache).
        // Provisioning DynamoDB anyway is a billed, unused resource, and
        // OpenNext omits the `dynamodb-provider` bundle in this mode so there
        // would be nothing to seed it with.
        const tagCacheEnabled =
          output.additionalProps?.disableTagCache !== true;

        // Seed the DynamoDB tag table with the build's prebuilt tag rows
        // via OpenNext's dynamodb-provider (a CFN-custom-resource handler
        // bundling `dynamodb-cache.json`). Without it, tag revalidation
        // can't purge a page until that page has been hit once.
        const initFnMeta = output.additionalProps?.initializationFunction;
        const initFnDir = path.join(openNextDir, 'dynamodb-provider');
        const initFunction =
          tagCacheEnabled && initFnMeta && fs.existsSync(initFnDir)
            ? {
                bundle: initFnDir,
                handler: initFnMeta.handler ?? 'index.handler',
              }
            : undefined;

        manifest.cache = {
          computeResource: primaryComputeName,
          tagRevalidation: tagCacheEnabled,
          revalidationQueue: true,
          revalidationFunction: hasRevalidationFn
            ? { bundle: revalidationFnDir, handler: 'index.handler' }
            : undefined,
          ...(seedDirectory ? { seedDirectory } : {}),
          ...(initFunction ? { initFunction } : {}),
        };
      }
    }
  }

  // Image optimization
  if (output.additionalProps?.imageOptimization !== false) {
    const imgDir = path.join(openNextDir, 'image-optimization-function');
    if (fs.existsSync(imgDir)) {
      const imgConfig = tryReadJson(path.join(imgDir, 'config.json'));
      manifest.imageOptimization = {
        bundle: imgDir,
        handler: 'index.handler',
        formats: (imgConfig?.formats as string[] | undefined) ?? [
          'webp',
          'avif',
        ],
        sizes: (imgConfig?.sizes as number[] | undefined) ?? [
          640, 750, 828, 1080, 1200, 1920, 2048, 3840,
        ],
      };
    }
  }

  // Middleware
  const middlewareDir = path.join(openNextDir, 'middleware');
  if (fs.existsSync(middlewareDir)) {
    const middlewareManifest = tryReadJson(
      path.join(middlewareDir, 'manifest.json'),
    );
    manifest.middleware = {
      bundle: middlewareDir,
      handler: 'handler.handler',
      matchers: (middlewareManifest?.matchers as string[] | undefined) ?? [
        '/*',
      ],
    };
  }

  return manifest;
};

/**
 * Map an OpenNext origin to a ComputeResource.
 */
const mapOriginToCompute = (
  name: string,
  origin: OpenNextOrigin,
  openNextDir: string,
): ComputeResource | undefined => {
  const bundleDir = path.join(openNextDir, 'server-functions', name);

  const effectiveBundle = fs.existsSync(bundleDir)
    ? bundleDir
    : path.join(openNextDir, 'server-function');

  if (!fs.existsSync(effectiveBundle)) {
    return undefined;
  }

  if (origin.type === 'function' || origin.type === undefined) {
    return {
      type: 'handler',
      bundle: effectiveBundle,
      handler: origin.handler ?? 'index.handler',
      placement: 'regional',
      streaming: origin.streaming ?? true,
      runtime: origin.runtime ?? 'nodejs20.x',
      memorySize: origin.memorySize,
      timeout: origin.timeout,
      environment: origin.environment,
    };
  }

  if (origin.type === 'ecs' || origin.type === 'docker') {
    return {
      type: 'http-server',
      bundle: effectiveBundle,
      entrypoint: origin.entrypoint ?? 'server.js',
      port: origin.port ?? 3000,
      placement: 'regional',
      streaming: origin.streaming ?? false,
      runtime: origin.runtime ?? 'nodejs20.x',
      environment: origin.environment,
    };
  }

  if (origin.type === 'edge') {
    return {
      type: 'edge',
      bundle: effectiveBundle,
      handler: origin.handler ?? 'index.handler',
      placement: 'global',
      streaming: false,
      runtime: origin.runtime ?? 'nodejs20.x',
      environment: origin.environment,
    };
  }

  // Unknown type — treat as handler
  return {
    type: 'handler',
    bundle: effectiveBundle,
    handler: 'index.handler',
    placement: 'regional',
    streaming: origin.streaming ?? true,
    runtime: 'nodejs20.x',
  };
};

/**
 * Normalize OpenNext origin names to match the construct's compute resource keys.
 */
const normalizeOriginName = (name: string): string => {
  const originNameMap: Record<string, string> = {
    imageOptimizer: 'image-optimization',
  };
  return originNameMap[name] ?? name;
};

/**
 * Map OpenNext behaviors to RouteBehavior array.
 */
const mapBehaviorsToRoutes = (
  behaviors: OpenNextBehavior[],
): RouteBehavior[] => {
  const routes: RouteBehavior[] = [];

  for (const behavior of behaviors) {
    // Edge behaviors carry `edgeFunction` instead of `origin` — point the
    // route at that compute name so CdnConstruct can attach the Lambda@Edge
    // function to the matching cache behavior.
    const target = behavior.edgeFunction
      ? behavior.edgeFunction
      : normalizeOriginName(behavior.origin ?? 'default');
    routes.push({
      pattern: nextPatternToCloudFront(behavior.pattern),
      target,
      fallback: behavior.fallback,
    });
  }

  // Ensure a catch-all exists
  const hasCatchAll = routes.some(
    (r) => r.pattern === '/*' || r.pattern === '*',
  );
  if (!hasCatchAll && routes.length > 0) {
    routes.push({
      pattern: '/*',
      target: 'default',
    });
  }

  return routes;
};

/**
 * Translate Next.js / OpenNext route patterns into CloudFront PathPatterns.
 *
 * OpenNext emits behaviors with patterns in Next-style syntax:
 *   `/api/edge/[slug]`            (dynamic segment)
 *   `/api/edge/catch/[...path]`   (catch-all)
 * CloudFront supports only `*` (match any) and `?` (match single char) and
 * rejects `[]/{}/+/?...` as regex syntax. The translator collapses each
 * dynamic segment to a single `*` and turns catch-all segments into a
 * trailing `*`. The result still uniquely identifies the route prefix
 * because CloudFront path patterns are evaluated longest-match-first.
 *
 *   `/api/edge/[slug]`            → `/api/edge/*`
 *   `/api/edge/catch/[...path]`   → `/api/edge/catch/*`
 *   `/products/[id]/reviews/[r]`  → `/products/*\/reviews/*`
 */
const nextPatternToCloudFront = (pattern: string): string => {
  // Collapse catch-all `[...name]` (must come first; it's a superset).
  let out = pattern.replace(/\[\.\.\..+?\]/g, '*');
  // Collapse single dynamic segments `[name]`.
  out = out.replace(/\[[^/\]]+?\]/g, '*');
  return out;
};

/**
 * Safely read and parse a JSON file, returning undefined on failure.
 */
const tryReadJson = (filePath: string): Record<string, unknown> | undefined => {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
    
  } catch {
    // Ignore parse errors — caller handles undefined
  }
  return undefined;
};
