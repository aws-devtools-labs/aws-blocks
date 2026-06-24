/**
 * Nitro adapter — works for any framework that builds with Nitro.
 *
 * Nitro is a framework-agnostic server engine (https://nitro.unjs.io)
 * used by Nuxt, SolidStart, Analog, TanStack Start, and standalone Nitro
 * apps. They all emit the same `.output/` directory shape, so a single
 * adapter can translate any of them into a DeployManifest.
 *
 * Inputs read from `.output/`:
 *   - `nitro.json`  — preset, framework metadata, routeRules
 *   - `server/`     — the Lambda bundle
 *   - `public/`     — static assets + prerendered HTML
 *
 * The L3 construct never knows which UI framework produced this — it
 * only sees compute resources, route patterns, and a static-assets dir.
 */
import { spawn } from './spawn.js';
import { validateCacheControl } from './shared/cache_control.js';
import {
  warnIfVercelCron,
  warnUnschedulableCron,
  warnUnsupportedWebSocket,
} from './shared/feature_warnings.js';
import * as fs from 'fs';
import * as path from 'path';
import fg from 'fast-glob';
import semver from 'semver';
import { getPackageInfoSync, isPackageExists } from 'local-pkg';
import { HostingError } from '../hosting_error.js';
import type {
  ComputeResource,
  DeployManifest,
  RouteBehavior,
} from '../manifest/types.js';
import { NITRO_CACHE_PLUGIN_SOURCE } from './nitro_cache_plugin_template.js';
import {
  IPX_LAMBDA_HANDLER_SOURCE,
  IPX_LAMBDA_PACKAGE_JSON,
} from './ipx_lambda_template.js';
import { normalizeBasePath } from './shared/basepath.js';

export type NitroAdapterOptions = {
  /** Project root directory (the directory containing the framework config) */
  projectDir: string;
  /** Skip the build step (use a pre-existing .output/) */
  skipBuild?: boolean;
  /**
   * Override the Nitro preset to build with.
   *
   * Defaults to `'aws-lambda'` which produces an AWS Lambda handler.
   * To enable response streaming, set `nitro.awsLambda.streaming: true`
   * in the user's `nuxt.config.ts` (the adapter reads this from
   * `.output/nitro.json`). `'node-server'` produces a plain Node HTTP
   * server (run via the Lambda Web Adapter).
   */
  preset?: string;
  /**
   * Build command override. Defaults to `npm run build`, which works for
   * Nuxt, SolidStart, Analog, TanStack Start, and any Nitro-based project
   * that wires `build` to its framework's CLI in package.json.
   *
   * Pass an explicit array (e.g. `['nuxt', 'build']`) to bypass npm and
   * call the framework CLI directly.
   */
  buildCommand?: string[];
};

/** Subset of `.output/nitro.json` we rely on. */
type NitroBuildInfo = {
  preset?: string;
  framework?: { name?: string; version?: string };
  serverEntry?: string;
  publicDir?: string;
  /**
   * Nitro reports the resolved server/public output directories under
   * an `output` block on recent versions. We honor these instead of
   * hardcoding `.output/server` and `.output/public` so the adapter
   * keeps working when Nitro renames the dirs OR the user sets custom
   * `output:` paths in nitro/nuxt config.
   */
  output?: {
    serverDir?: string;
    publicDir?: string;
  };
  routeRules?: Record<string, NitroRouteRule>;
  config?: {
    awsLambda?: { streaming?: boolean };
    /**
     * Nitro WebSocket runtime. Lambda Function URLs and API Gateway
     * HTTP/REST cannot complete the WS upgrade (no persistent socket;
     * Nitro itself only lists Node/Bun/Deno/Cloudflare as WS-capable
     * targets, not AWS Lambda) — we throw at adapter time rather than ship
     * a runtime that silently 200s instead of 101s.
     *
     * The flag was renamed across Nitro majors: Nitro 2.x used
     * `experimental.websocket`; Nitro 3 / the `nitro` package uses
     * `features.websocket`. We check both so the guard keeps firing.
     */
    experimental?: { websocket?: boolean };
    features?: { websocket?: boolean };
    /**
     * Cron-like tasks. Vercel/Cloudflare wire these to platform schedulers;
     * the managed hosting service has no EventBridge wiring today, so they would
     * silently never fire. Throw at adapter time.
     */
    scheduledTasks?: Record<string, string[]> | string[];
  };
};

/**
 * Nitro presets we support. Anything else falls back to producing an
 * AWS Lambda bundle, which crashes on cold start when the user's source
 * targets Cloudflare/Vercel/etc.-specific runtimes.
 */
const SUPPORTED_NITRO_PRESETS: ReadonlySet<string> = new Set([
  'aws-lambda',
  'aws-lambda-streaming',
  'node-server',
  'node',
]);

/**
 * `stale-while-revalidate` window (seconds) emitted for SWR route rules.
 * One year — matches the SWR window OpenNext/Next emit for ISR pages
 * (`stale-while-revalidate=31536000`): once a page is fresh-cached, a stale
 * copy can still be served for essentially this long while the background
 * refresh runs. The freshness window is the rule's own `maxAge` (the
 * `s-maxage`); this constant is only the trailing stale grace period.
 */
const SWR_STALE_WINDOW_SECONDS = 31536000;

/**
 * Verified Nitro version range. The aws-lambda handler patcher
 * (`patchNitroHandlerForApiGateway`) and the dep-store materializer
 * have been exercised against Nitro 2.10–2.13; the range below
 * encodes that. Exported for the X.1 cross-adapter version-pin test.
 *
 * "Verified" means **believed compatible**, not tested against every
 * release. The upper bound is the next minor we have NOT validated
 * (`<2.14.0`) rather than the whole 2.x line (`<3.0.0`): a breaking
 * change can land in a minor, and a too-wide range would overstate the
 * compatibility we've actually confirmed. Bump the ceiling in lockstep
 * with verifying a new minor.
 *
 * This constant documents the verified range and is consumed by the
 * X.1 cross-adapter version-pin test. The runtime safety net is the
 * version-range warning (`warnIfNitroOutOfRange`), NOT a hard failure in the
 * patcher: zero patches is a legitimate state — Nitro v3 (and any release
 * that adopts a REST-compatible request shape) needs no patch at all, and a
 * throw there would break a build that actually works. The patcher therefore
 * warns (not throws) on zero patches; the version warning is what flags an
 * unverified nitropack so a genuine signature drift is investigated.
 */
export const VERIFIED_NITRO_RANGE = '>=2.10.0 <2.14.0';

/**
 * Warn when the installed `nitropack` is outside {@link VERIFIED_NITRO_RANGE}.
 * Mirrors the Next.js adapter's `warnIfOpenNextOutOfRange`: advisory only —
 * the hard safety net is the patcher's `UpstreamPatchPatternChangedError`.
 * @internal
 */
export const warnIfNitroOutOfRange = (projectDir: string): void => {
  const info = getPackageInfoSync('nitropack', { paths: [projectDir] });
  const version = info?.version;
  if (!version || !semver.valid(version)) return;
  if (semver.satisfies(version, VERIFIED_NITRO_RANGE)) return;
  process.stderr.write(
    `⚠️  nitropack@${version} is outside the version range this adapter was verified against (${VERIFIED_NITRO_RANGE}). ` +
      `If the aws-lambda handler patcher errors with UpstreamPatchPatternChangedError, that's the most likely cause — pin to a verified version or file an issue.\n`,
  );
};

/**
 * Throw `UnsupportedNitroPresetError` when the resolved preset isn't
 * one we know how to wire into AWS infrastructure. Without this check,
 * the adapter falls through to producing an aws-lambda handler shape
 * regardless of what the user picked, and the Lambda crashes on cold
 * start with `Cannot find module 'cloudflare'` (or similar).
 */
const validateNitroPreset = (preset: string): void => {
  if (SUPPORTED_NITRO_PRESETS.has(preset)) return;
  throw new HostingError('UnsupportedNitroPresetError', {
    message: `Nitro preset "${preset}" is not supported by this hosting stack.`,
    resolution: `Set NITRO_PRESET (or nitro.preset in your framework config) to one of: ${Array.from(
      SUPPORTED_NITRO_PRESETS,
    ).join(', ')}.`,
  });
};

/**
 * Warn (do NOT throw) about Nitro features that produce a deployable bundle
 * but can't work on this architecture:
 *   - WebSocket (`experimental.websocket` in Nitro 2.x, `features.websocket`
 *     in Nitro 3) — Lambda + API Gateway REST can't complete the WS upgrade
 *     (Nitro only supports WS on Node/Bun/Deno/Cloudflare, not AWS Lambda).
 *   - `scheduledTasks` — Vercel/Cloudflare wire these to platform schedulers;
 *     we have no EventBridge wiring, so the cron silently never fires.
 *
 * Warnings, not hard errors: neither feature is widely supported on
 * serverless SSR, and the rest of the app deploys and serves correctly. We
 * surface a clear warning so the unsupported behavior isn't a silent runtime
 * surprise, but we don't block the deploy.
 */
const warnNitroUnsupportedFeatures = (info: NitroBuildInfo): void => {
  // Nitro renamed the flag: 2.x = `experimental.websocket`, 3.x / `nitro`
  // package = `features.websocket`. Check both so the warning survives the
  // major bump.
  if (
    info.config?.experimental?.websocket === true ||
    info.config?.features?.websocket === true
  ) {
    warnUnsupportedWebSocket(
      'Nitro WebSocket support (`experimental.websocket` / `features.websocket: true`)',
    );
  }
  const tasks = info.config?.scheduledTasks;
  const hasScheduledTasks = Array.isArray(tasks)
    ? tasks.length > 0
    : tasks && Object.keys(tasks).length > 0;
  if (hasScheduledTasks) {
    warnUnschedulableCron('Nitro `scheduledTasks` are declared');
  }
};

type NitroRouteRule = {
  prerender?: boolean;
  redirect?: string | { to: string; statusCode?: 301 | 302 | 307 | 308 };
  headers?: Record<string, string>;
  cors?: boolean;
  cache?: { swr?: boolean; maxAge?: number };
  /**
   * `routeRules.proxy: 'https://upstream.example/**'` — Nitro's
   * upstream-proxy rule. Today the SSR Lambda relays this on every hit
   * (paid Lambda invocation). The adapter lifts the rule into
   * `manifest.rewrites[]`; the L3 will route it via CloudFront's
   * origin-rewrite path once that's wired (tracked separately). Until then
   * the proxy still works via the SSR Lambda runtime — the L3 warns that it
   * isn't edge-optimized rather than failing the deploy.
   */
  proxy?: string | { to: string };
};

/**
 * Run the framework's build (unless skipped) and translate `.output/`
 * into a DeployManifest.
 * @param options - adapter options
 * @returns framework-agnostic DeployManifest ready for the L3 construct
 */
export const nitroAdapter = (options: NitroAdapterOptions): DeployManifest => {
  const { projectDir, skipBuild, preset, buildCommand } = options;
  const effectivePreset = preset ?? 'aws-lambda';

  const outputDir = path.join(projectDir, '.output');
  const nitroJsonPath = path.join(outputDir, 'nitro.json');
  // Default Nitro output layout. Overridden below when nitro.json
  // declares its own `output.serverDir` / `output.publicDir` (defensive:
  // protects us against future Nitro renames; user-configured `output:`
  // sections in nitro.config also flow through).
  let serverDir = path.join(outputDir, 'server');
  let publicDir = path.join(outputDir, 'public');

  if (!skipBuild) {
    // Wipe Nuxt/Nitro build caches before each build so the file-system
    // auto-scan re-discovers nested `server/api/<subdir>/*` handlers.
    // Symptom we're guarding against: a previous deploy seeds `.nuxt/`
    // with a routing table that didn't include the new handler; the
    // next `npm run build` reuses that cached table and the new route
    // 404s on production. Wiping the framework-owned caches is safe —
    // they are regenerated by the build — and confined to the
    // adapter's working tree (we never touch user source).
    cleanNitroBuildCaches(projectDir);

    // Inject the S3 cache plugin into the user's source tree so
    // Nitro picks it up at build time. Always remove it after the
    // build completes (even on failure) so we never leave artefacts
    // in the user's repo.
    const cachePluginCleanup = installNitroCachePlugin(projectDir);
    try {
      runNitroBuild(projectDir, effectivePreset, buildCommand);
    } finally {
      cachePluginCleanup();
    }
  }

  if (!fs.existsSync(outputDir)) {
    throw new HostingError('NitroOutputNotFoundError', {
      message: `Nitro .output/ not found at ${outputDir}.`,
      resolution:
        'Ensure the framework build succeeded. Re-run it manually with NITRO_PRESET=aws-lambda to diagnose.',
    });
  }

  let nitroInfo: NitroBuildInfo = {};
  if (fs.existsSync(nitroJsonPath)) {
    try {
      nitroInfo = JSON.parse(fs.readFileSync(nitroJsonPath, 'utf-8'));
    } catch (error) {
      throw new HostingError(
        'NitroOutputParseError',
        {
          message: `Failed to parse Nitro build info at ${nitroJsonPath}.`,
          resolution:
            'The .output/nitro.json file contains invalid JSON. Try running the build again.',
        },
        error as Error,
      );
    }
  }

  // Honor Nitro's reported output paths when present. nitro.json emits
  // these as either absolute paths or paths relative to the project root.
  // Hardcoding `.output/server` and `.output/public` works today but
  // would break silently if Nitro renames the dirs (or the user
  // configures custom output paths via nitro.config).
  if (nitroInfo.output?.serverDir) {
    serverDir = path.isAbsolute(nitroInfo.output.serverDir)
      ? nitroInfo.output.serverDir
      : path.join(projectDir, nitroInfo.output.serverDir);
  }
  if (nitroInfo.output?.publicDir) {
    publicDir = path.isAbsolute(nitroInfo.output.publicDir)
      ? nitroInfo.output.publicDir
      : path.join(projectDir, nitroInfo.output.publicDir);
  }

  if (!skipBuild) {
    // Nitro's aws-lambda preset reads event.rawPath / requestContext.http
    // (HTTP API v2 / Function URL shape). The L3 fronts SSR with REST API
    // (payload v1: event.path / requestContext.httpMethod). Without the
    // patch every URL renders as `/`. See patchNitroHandlerForApiGateway.
    if (effectivePreset === 'aws-lambda') {
      // Flag an unverified nitropack BEFORE patching so a signature drift
      // (or a v3 build that legitimately needs no patch) is contextualized.
      warnIfNitroOutOfRange(projectDir);
      patchNitroHandlerForApiGateway(serverDir);
    }
  }

  if (!fs.existsSync(serverDir)) {
    throw new HostingError('NitroOutputNotFoundError', {
      message: `Nitro server bundle not found at ${serverDir}.`,
      resolution:
        'The build did not produce a server output. Check your framework config and the Nitro preset.',
    });
  }

  // Materialise Nitro's pnpm-style isolated dep store. Nitro 2.13.4+
  // emits `node_modules/.nitro/<pkg>@<ver>/` and uses relative symlinks
  // from `node_modules/<pkg>/` into the store. The store contains cyclic
  // symlinks that crash CDK's asset hasher on macOS with ENAMETOOLONG
  // once the cycle exhausts PATH_MAX, so we have to remove `.nitro/` —
  // but the Lambda bundle DOES resolve transitive deps (e.g.
  // @smithy/util-utf8 from @aws-crypto/util) through those symlinks at
  // runtime, so we must dereference them into real copies before
  // removing the store. See `materializeNitroDepStore` doc for the full
  // failure mode this prevents.
  materializeNitroDepStore(serverDir);

  // Note: Injecting config files into server bundles is an integration-layer
  // concern, not an adapter concern. If a consumer needs files copied into
  // Lambda bundles, handle it in the orchestration layer that calls the adapter.

  // Strip pre-compressed sibling files (.gz / .br / .zst). We let
  // CloudFront re-compress on the edge instead — the per-edge cache
  // would otherwise hold N variants per object without negotiating
  // them, and the storage savings are eaten by upload time.
  prunePreCompressedAssets(publicDir);

  // If the user has @nuxt/image installed, build a standalone IPX
  // Lambda bundle so sharp doesn't bloat the SSR Lambda. The bundle
  // is referenced via `manifest.imageOptimization` later on.
  const imageOptBundle = buildImageOptBundleIfNeeded(projectDir);
  // @nuxt/image's `runtimeConfig.ipx.baseURL` lets users serve IPX
  // from a path other than the default `/_ipx`. We need the same
  // value so the CloudFront cache behavior + Lambda strip match.
  const ipxBaseURL = imageOptBundle ? findIpxBaseURL(projectDir) : undefined;
  // @nuxt/image `image.domains` → remote-source allowlist for the IPX Lambda.
  const imageDomains = imageOptBundle ? findNuxtImageDomains(projectDir) : [];

  // Merge route rules from the user's nuxt.config.ts (visible in
  // nitro.json on some Nitro versions) with the rules Nitro itself
  // bakes into the server bundle (Cache-Control for /_nuxt/**,
  // /_nuxt/builds/**, custom publicAssets entries, etc.). The bundled
  // ones include framework-default Cache-Control headers we want to
  // preserve.
  const bundledRouteRules = readBundledRouteRules(serverDir);
  const mergedRouteRules: Record<string, NitroRouteRule> = {
    ...bundledRouteRules,
    ...(nitroInfo.routeRules ?? {}),
  };

  const resolvedPreset = nitroInfo.preset ?? effectivePreset;
  const awsLambdaStreaming = nitroInfo.config?.awsLambda?.streaming === true;
  validateNitroPreset(resolvedPreset);
  warnNitroUnsupportedFeatures(nitroInfo);
  // Nuxt/Nitro projects can also carry a vercel.json with crons (e.g. set up
  // for a Vercel preview) — warn for parity with the Next/Astro path.
  warnIfVercelCron(projectDir);
  // basePath: Nuxt's `app.baseURL` (parity with Next `basePath` / Astro
  // `base`). It's not in `.output/nitro.json`, so we read it from the
  // server bundle's baked runtime config. Without this the prefix is
  // dropped: the framework emits `/<base>/_nuxt/*` asset URLs but no
  // matching CloudFront behavior is created, so every hashed asset 404s
  // and the app renders but never hydrates.
  const basePath = normalizeBasePath(readBundledBaseURL(serverDir));

  // Safety net: if the bundle scan found nothing but the prerendered HTML
  // clearly references a non-root `/<prefix>/_nuxt/` asset path, the
  // extraction missed a real baseURL (e.g. a future Nitro bundle-shape
  // change). Fail loud rather than silently shipping a broken site.
  if (!basePath) {
    const htmlPrefix = detectBaseURLFromPrerenderedHtml(publicDir);
    if (htmlPrefix) {
      throw new HostingError('NuxtBaseURLDetectionError', {
        message:
          `Detected a non-root asset prefix "${htmlPrefix}/_nuxt/" in the ` +
          `prerendered output, but could not read app.baseURL from the ` +
          `Nitro server bundle to model it.`,
        resolution:
          'This is likely an unsupported Nitro/Nuxt version whose bundle ' +
          'layout changed. Please report it; as a workaround, deploy without ' +
          '`app.baseURL` until support catches up.',
      });
    }
  }

  return buildManifest({
    preset: resolvedPreset,
    serverDir,
    publicDir,
    routeRules: mergedRouteRules,
    awsLambdaStreaming,
    imageOptBundle,
    ipxBaseURL,
    imageDomains,
    basePath,
  });
};

/**
 * Framework-managed cache directories that Nitro / Nuxt regenerate on
 * every build. Removing them forces the auto-scan to re-walk
 * `server/api/**` etc. so newly-added nested handlers are picked up.
 *
 * Why these specifically:
 *   - `.nuxt/`        — Nuxt's typegen + virtual route cache; the
 *                       culprit for nested-server-route 404s when
 *                       a handler added between deploys was missed.
 *   - `.output/`      — Nitro's previous build artefacts; wiping
 *                       avoids stale serverless bundles being
 *                       repackaged when the build short-circuits.
 *   - `node_modules/.cache/nitro/`
 *                     — Nitro's incremental build cache; its scan
 *                       table can stick across redeploys.
 *
 * We never touch `node_modules/` itself, `package.json`, lockfiles,
 * or anything outside the project's framework caches.
 */
const cleanNitroBuildCaches = (projectDir: string): void => {
  const caches = [
    path.join(projectDir, '.nuxt'),
    path.join(projectDir, '.output'),
    path.join(projectDir, 'node_modules', '.cache', 'nitro'),
  ];
  for (const dir of caches) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
};

/**
 * Execute the framework's build via the user's package.json scripts.
 *
 * Default `npm run build` works across Nuxt, SolidStart, Analog,
 * TanStack Start, and standalone Nitro apps because each one wires its
 * own `build` script. We pass NITRO_PRESET via env so any Nitro-backed
 * framework targets the right runtime without per-framework branching.
 */
const runNitroBuild = (
  projectDir: string,
  preset: string,
  buildCommand?: string[],
): void => {
  const cmd =
    buildCommand && buildCommand.length > 0
      ? buildCommand
      : ['npm', 'run', 'build'];
  process.stderr.write(
    `\u{1F528} Running build (NITRO_PRESET=${preset}): ${cmd.join(' ')}\n`,
  );
  try {
    const [bin, ...args] = cmd;
    spawn.sync(bin!, args, {
      cwd: projectDir,
      stdio: 'inherit',
      env: { ...process.env, NITRO_PRESET: preset },
    });
  } catch (error) {
    throw new HostingError(
      'NitroBuildError',
      {
        message: 'Framework build failed.',
        resolution:
          'Check the build output above for errors. Common causes:\n' +
          '  - Missing dependencies (run: npm install)\n' +
          '  - Invalid framework config\n' +
          '  - TypeScript errors in your app\n' +
          '  - Unsupported NITRO_PRESET for the installed framework version',
      },
      error as Error,
    );
  }
};

/**
 * Filename injected into the user's `server/plugins/`. The leading
 * underscore avoids ordering collisions with user-named plugins.
 */
const CACHE_PLUGIN_FILENAME = '_hosting-cache.mjs';

/**
 * Copy the S3 cache plugin into the user's `server/plugins/`
 * before Nitro builds. Returns a cleanup function that removes the
 * file (and the `server/plugins/` directory if we created it).
 *
 * Refuses to overwrite a pre-existing file at the target path —
 * silently overwriting and then deleting on cleanup would destroy
 * user code with no warning.
 */
const installNitroCachePlugin = (projectDir: string): (() => void) => {
  const pluginsDir = path.join(projectDir, 'server', 'plugins');
  const pluginPath = path.join(pluginsDir, CACHE_PLUGIN_FILENAME);

  if (fs.existsSync(pluginPath)) {
    throw new HostingError('NitroCachePluginCollisionError', {
      message: `A file already exists at ${pluginPath}; the Nitro cache plugin would overwrite it.`,
      resolution: `Rename or delete ${CACHE_PLUGIN_FILENAME} in your server/plugins/ directory. The Nitro adapter writes its own ${CACHE_PLUGIN_FILENAME} during the build to plumb framework SWR/ISR through the deploy-provisioned S3 cache, then removes it on cleanup.`,
    });
  }

  // Track what we created so cleanup is exact.
  const createdPluginsDir = !fs.existsSync(pluginsDir);
  const createdServerDir = !fs.existsSync(path.join(projectDir, 'server'));

  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(pluginPath, NITRO_CACHE_PLUGIN_SOURCE, 'utf-8');

  return (): void => {
    try {
      if (fs.existsSync(pluginPath)) fs.rmSync(pluginPath);
      // Remove the directories ONLY if we created them — never touch
      // user-owned dirs.
      if (createdPluginsDir && fs.existsSync(pluginsDir)) {
        const entries = fs.readdirSync(pluginsDir);
        if (entries.length === 0) fs.rmdirSync(pluginsDir);
      }
      if (createdServerDir) {
        const serverDir = path.join(projectDir, 'server');
        if (fs.existsSync(serverDir)) {
          const entries = fs.readdirSync(serverDir);
          if (entries.length === 0) fs.rmdirSync(serverDir);
        }
      }
      
    } catch {
      // Best-effort cleanup. Failure to delete shouldn't fail the deploy.
    }
  };
};

/**
 * Resolve the path to Nitro's main server bundle (`nitro.mjs`) inside
 * `<serverDir>/chunks/`.
 *
 * Nitro/Rollup picks the chunk directory name based on the build inputs;
 * we've observed both `chunks/nitro/nitro.mjs` (Linux/macOS) and
 * `chunks/_/nitro.mjs` (Windows) for the same Nitro version on the same
 * fixture. Probe known names first, then fall back to a single-level
 * scan of `chunks/*` so a future rename doesn't silently disable the
 * route-rule extraction or aws-lambda handler patch.
 * @internal
 */
export const resolveNitroBundlePath = (
  serverDir: string,
): string | undefined => {
  const chunksDir = path.join(serverDir, 'chunks');
  if (!fs.existsSync(chunksDir)) return undefined;
  for (const candidate of ['nitro', '_']) {
    const p = path.join(chunksDir, candidate, 'nitro.mjs');
    if (fs.existsSync(p)) return p;
  }
  for (const entry of fs.readdirSync(chunksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = path.join(chunksDir, entry.name, 'nitro.mjs');
    if (fs.existsSync(p)) return p;
  }
  return undefined;
};

/**
 * Read the routeRules object Nitro embedded in the server bundle.
 *
 * The bundle contains a JSON-shaped `_inlineRuntimeConfig` literal whose
 * `nitro.routeRules` field holds every per-pattern rule Nitro produced —
 * both the user's `routeRules` from `nuxt.config.ts` and the framework
 * defaults (e.g. immutable Cache-Control on `/_nuxt/**`, custom
 * `publicAssets` entries with their `maxAge`).
 *
 * The literal usually lives in `chunks/nitro/nitro.mjs`, but Nitro's
 * chunking sometimes puts it elsewhere (e.g. `chunks/_/nitro.mjs` or
 * `index.mjs` on Windows due to a v2 prefix-match bug). Probe the most
 * likely candidates; returns {} if no file contains the marker.
 *
 * `nitro.json` doesn't expose this in current versions, so we extract
 * it via regex from the bundle — best-effort, never blocking.
 */
const readBundledRouteRules = (
  serverDir: string,
): Record<string, NitroRouteRule> => {
  const candidates: string[] = [];
  const bundlePath = resolveNitroBundlePath(serverDir);
  if (bundlePath) candidates.push(bundlePath);
  const indexPath = path.join(serverDir, 'index.mjs');
  if (fs.existsSync(indexPath)) candidates.push(indexPath);

  for (const candidate of candidates) {
    const source = fs.readFileSync(candidate, 'utf-8');
    const blob = extractJsonObjectAfter(source, '"routeRules":');
    if (!blob) continue;
    try {
      return JSON.parse(blob) as Record<string, NitroRouteRule>;

    } catch {
      // Malformed extraction — try next candidate.
    }
  }
  return {};
};

/**
 * Extract Nuxt's `app.baseURL` from the built server bundle.
 *
 * `app.baseURL` (Next's `basePath` / Astro's `base` equivalent) is NOT
 * surfaced in `.output/nitro.json`, but Nitro bakes it into the runtime
 * config inside the server bundle as a single `"baseURL": "<value>"`
 * entry. We read it from there (the same bundle-scan approach as
 * {@link readBundledRouteRules}) rather than parsing `nuxt.config.ts`.
 *
 * Returns the raw value (e.g. `'/myapp/'`), or `undefined` when absent or
 * the default `'/'` (which means "no base path").
 * @internal
 */
const readBundledBaseURL = (serverDir: string): string | undefined => {
  const candidates: string[] = [];
  const bundlePath = resolveNitroBundlePath(serverDir);
  if (bundlePath) candidates.push(bundlePath);
  const indexPath = path.join(serverDir, 'index.mjs');
  if (fs.existsSync(indexPath)) candidates.push(indexPath);

  for (const candidate of candidates) {
    const source = fs.readFileSync(candidate, 'utf-8');
    // The runtime-config blob embeds it as `"baseURL": "/myapp/"`.
    const match = source.match(/"baseURL"\s*:\s*"([^"]*)"/);
    if (match) {
      const value = match[1];
      return value === '/' ? undefined : value;
    }
  }
  return undefined;
};

/**
 * Safety net for {@link readBundledBaseURL}: if the bundle scan came up
 * empty but the prerendered HTML clearly shows a non-root asset prefix
 * (e.g. `/myapp/_nuxt/...`), the extraction silently missed a real
 * baseURL — a future Nitro bundle-shape change would otherwise re-open the
 * "baseURL dropped → assets 404" bug. Fail loud instead.
 *
 * Returns the prefix detected in HTML (normalized, no `_nuxt`), or
 * `undefined` when none (the common no-baseURL case).
 * @internal
 */
const detectBaseURLFromPrerenderedHtml = (
  publicDir: string,
): string | undefined => {
  const htmlFiles = fg.sync('**/*.html', {
    cwd: publicDir,
    absolute: true,
    onlyFiles: true,
  });
  for (const file of htmlFiles.slice(0, 20)) {
    const html = fs.readFileSync(file, 'utf-8');
    // Match an absolute asset reference like `/myapp/_nuxt/abc.js`. The
    // default (root) build emits `/_nuxt/...`, which yields prefix ''.
    const m = html.match(/["'(](\/[^"'()]*?)\/_nuxt\//);
    if (m) {
      const prefix = m[1]; // '' for root, '/myapp' for a base path
      return prefix === '' ? undefined : prefix;
    }
  }
  return undefined;
};

/**
 * Find the first `{...}` JSON object that follows `marker` in `source`,
 * tracking brace depth so nested objects don't terminate early.
 * @internal
 */
export const extractJsonObjectAfter = (
  source: string,
  marker: string,
): string | undefined => {
  const start = source.indexOf(marker);
  if (start === -1) return undefined;
  const open = source.indexOf('{', start + marker.length);
  if (open === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return undefined;
};

/**
 * Remove pre-compressed sibling files (`*.gz`, `*.br`, `*.zst`) from
 * the public directory so they aren't uploaded to S3. CloudFront's
 * `compress: true` re-compresses on the edge based on `Accept-Encoding`,
 * which works correctly without these variants and avoids the cache-key
 * complexity needed to negotiate them.
 */
const prunePreCompressedAssets = (publicDir: string): void => {
  if (!fs.existsSync(publicDir)) return;
  const compressed = fg.sync('**/*.{gz,br,zst}', {
    cwd: publicDir,
    absolute: true,
    caseSensitiveMatch: false,
  });
  for (const f of compressed) {
    fs.rmSync(f);
  }
};

/**
 * Materialise Nitro's pnpm-style isolated dep store under
 * `<serverDir>/node_modules/.nitro/`, then remove the store.
 *
 * Nitro 2.13.4+ emits a layout where each dep lives at
 * `node_modules/.nitro/<pkg>@<version>/` and `node_modules/<pkg>/` is a
 * relative symlink into that store. The store itself contains cyclic
 * symlinks (a → b → a) which CDK's asset hasher walks on macOS until
 * `PATH_MAX` is exhausted, surfacing as
 * `ENAMETOOLONG: name too long, scandir` — that's why we need to remove
 * the store before CDK packages.
 *
 * The previous implementation just deleted `.nitro/` outright with the
 * comment "Nitro's server bundle inlines every import it needs at build
 * time, so nothing in the runtime path resolves through node_modules/."
 * That is FALSE for the `aws-lambda` preset: Nitro emits real CommonJS
 * files into `<serverDir>/node_modules/<pkg>/...` (e.g.
 * `@aws-crypto/util/build/main/convertToBuffer.js`) that DO `require()`
 * other transitive deps at runtime — `@smithy/util-utf8`,
 * `@smithy/util-buffer-from`, etc. Those transitive deps live under
 * `node_modules/@smithy/util-utf8 -> ../.nitro/@smithy/util-utf8@3.0.0`
 * (a relative symlink into the store). Deleting `.nitro/` left the
 * symlinks dangling, CDK packaged the broken zip, and the Lambda
 * crashed on init with `Cannot find module '@smithy/util-utf8'` —
 * surfaced loudest by the cache plugin's `import '@aws-sdk/client-s3'`,
 * but the bug was inherent to the dep layout for any nuxt SSR app.
 *
 * The fix: walk `<serverDir>/node_modules/` recursively, find every
 * symlink whose realpath points into `.nitro/`, and replace the symlink
 * with a deferenced copy of the target. Once every dep has been
 * materialised, remove `.nitro/`. The asset hasher gets its
 * cycle-free tree, and the Lambda gets every transitive dep it needs.
 */
const materializeNitroDepStore = (serverDir: string): void => {
  const nm = path.join(serverDir, 'node_modules');
  const nitroStore = path.join(nm, '.nitro');
  if (!fs.existsSync(nitroStore)) return;
  // Resolve `.nitro/` to its realpath up front. On macOS the tmp tree
  // (`/var/folders/...`) resolves to `/private/var/folders/...`, so the
  // symlinks we're about to inspect will report a `/private/`-prefixed
  // realpath; comparing against the unresolved nitroStore would
  // false-negative every match. Resolve once here so the later
  // startsWith check works on both real and symlinked tmp roots.
  const nitroStoreReal = fs.realpathSync(nitroStore);

  // Two-pass walk — collect symlinks first so we don't mutate the tree
  // we're traversing. We only follow real directories (lstat) — a
  // symlink encountered during the walk is a leaf, not a recursion
  // point, so cycles can't bite us here.
  const symlinks: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(full);
      } else if (entry.isDirectory()) {
        // Skip the dep store itself — its contents become real files via
        // the cpSync below, so there's no need to recurse into it.
        if (full === nitroStore) continue;
        walk(full);
      }
    }
  };
  walk(nm);

  // For each symlink whose realpath is inside `.nitro/`, replace the
  // symlink with a real copy of the target. `dereference: true` follows
  // any further symlinks during the copy, so we end up with no symlinks
  // remaining in the materialized output.
  for (const linkPath of symlinks) {
    let target: string;
    try {
      target = fs.realpathSync(linkPath);
    } catch {
      // Dangling symlink — best-effort: just remove it so it doesn't
      // confuse the asset hasher.
      try {
        fs.rmSync(linkPath, { force: true });
        
      } catch {
        // intentional
      }
      continue;
    }
    if (
      !target.startsWith(nitroStoreReal + path.sep) &&
      target !== nitroStoreReal
    ) {
      // Symlink that doesn't point into `.nitro/` — leave it alone.
      continue;
    }
    try {
      fs.rmSync(linkPath, { force: true });
      fs.cpSync(target, linkPath, { recursive: true, dereference: true });
      
    } catch {
      // Best effort. A failed materialise will surface as a runtime
      // `Cannot find module` in the Lambda; the user can re-deploy. We
      // don't want a transient FS hiccup to abort the whole build.
    }
  }

  // Now safe to delete the store — everything that pointed into it has
  // been replaced with a real copy.
  try {
    fs.rmSync(nitroStore, { recursive: true, force: true });
    
  } catch {
    // Best effort. If the store can't be removed, the asset hasher
    // surfaces its own error.
  }
};

/**
 * If the user's project depends on `@nuxt/image`, materialise a
 * standalone IPX Lambda bundle at `<projectDir>/<HOSTING_DIR>/image-optimization/`
 * so sharp doesn't bloat the SSR Lambda. Returns the absolute path to
 * the bundle directory, or undefined if no image-opt is needed.
 *
 * The bundle is reproducible: a fixed handler script (inlined in
 * ipx_lambda_template) plus an `npm install` targeting linux-x64 so
 * sharp's native binary matches the Lambda runtime.
 */
const buildImageOptBundleIfNeeded = (
  projectDir: string,
): string | undefined => {
  if (!projectUsesNuxtImage(projectDir)) return undefined;

  const bundleDir = path.join(
    projectDir,
    '.hosting',
    'image-optimization',
  );
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(
    path.join(bundleDir, 'index.mjs'),
    IPX_LAMBDA_HANDLER_SOURCE,
    'utf-8',
  );
  fs.writeFileSync(
    path.join(bundleDir, 'package.json'),
    IPX_LAMBDA_PACKAGE_JSON,
    'utf-8',
  );

  process.stderr.write(
    '\u{1F4F8} Building image-optimization Lambda bundle (sharp linux-x64)\n',
  );

  // Force npm to install Linux x64 binaries so sharp's native module
  // matches the Lambda runtime — Lambda is linux-x64.
  try {
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
      {
        cwd: bundleDir,
        stdio: 'inherit',
      },
    );
  } catch (error) {
    throw new HostingError(
      'ImageOptimizationBundleError',
      {
        message:
          'Failed to install image-optimization dependencies (ipx + sharp).',
        resolution:
          'Run `npm install` inside .hosting/image-optimization/ to diagnose.',
      },
      error as Error,
    );
  }

  // 2.4 — drop test fixtures, type defs, and other dead weight from
  // the Lambda zip. Lambda's 250 MB unzipped limit is the hard cap;
  // a >50 MB unzipped bundle also slows cold starts (Lambda's init
  // path differs above that threshold). sharp's native binary alone
  // is ~50 MB so every saved megabyte counts.
  pruneImageOptBundle(bundleDir);

  return bundleDir;
};

/**
 * Walk the IPX Lambda's installed `node_modules/` and delete things
 * that have no business shipping in a production zip:
 *   - `test/`, `tests/`, `__tests__/`, `test-fixtures/` directories
 *   - `*.md`, `*.markdown`, `LICENSE*`, `CHANGELOG*` files
 *   - `*.d.ts` declaration files (Lambda runtime is JS-only)
 *   - `*.map` source maps
 *   - `examples/`, `docs/`, `bench/` directories
 * Best-effort: any FS error is swallowed so a transient permissions
 * issue can't fail the deploy. The bundle remains usable even if the
 * prune is partial — these files just aren't on the runtime path.
 *
 * Skips `sharp/` entirely. sharp's tarball ships the native binary
 * inside `sharp/build/Release/` and `sharp/vendor/`; pruning anything
 * out of those breaks the install. Pruning sharp's `docs/` would be
 * safe in theory, but the library has changed its layout twice in
 * recent majors — easier to leave the entire package alone than to
 * track which directories are safe per version.
 */
const pruneImageOptBundle = (bundleDir: string): void => {
  const nm = path.join(bundleDir, 'node_modules');
  if (!fs.existsSync(nm)) return;

  const PRUNE_DIRS = new Set([
    'test',
    'tests',
    '__tests__',
    'test-fixtures',
    'examples',
    'example',
    'docs',
    'doc',
    'bench',
    'benchmark',
    'benchmarks',
    'coverage',
  ]);
  const PRUNE_FILE_PATTERNS = [
    /\.md$/i,
    /\.markdown$/i,
    /^license/i,
    /^changelog/i,
    /^changes$/i,
    /^history/i,
    /\.d\.ts$/i,
    /\.map$/i,
    /^\.eslintrc/i,
    /^\.npmignore$/i,
  ];

  const isInsideSharp = (p: string): boolean => {
    // path includes "node_modules/sharp" anywhere — covers nested
    // dep boundaries too.
    return p.split(path.sep).includes('sharp');
  };

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (isInsideSharp(full)) continue;
      if (entry.isDirectory()) {
        if (PRUNE_DIRS.has(entry.name.toLowerCase())) {
          try {
            fs.rmSync(full, { recursive: true, force: true });
            
          } catch {
            // best-effort
          }
          continue;
        }
        walk(full);
      } else if (entry.isFile()) {
        if (PRUNE_FILE_PATTERNS.some((re) => re.test(entry.name))) {
          try {
            fs.rmSync(full, { force: true });
            
          } catch {
            // best-effort
          }
        }
      }
    }
  };
  walk(nm);
};

/**
 * True if `@nuxt/image` is **installed** under the project's
 * `node_modules/` AND the user has not explicitly disabled the image
 * module in `nuxt.config`. The image-opt Lambda is only useful when
 * the runtime ships `<NuxtImg>` and uses the IPX provider; a declared
 * dep that was never installed (e.g. `npm install` not run) does not
 * count.
 */
const projectUsesNuxtImage = (projectDir: string): boolean => {
  if (!isPackageExists('@nuxt/image', { paths: [projectDir] })) {
    return false;
  }
  // The package is installed, but the user may have disabled the
  // module via nuxt.config — in that case <NuxtImg> isn't wired up and
  // our ~50 MB IPX Lambda would just sit unused.
  return !nuxtConfigBypassesIpx(projectDir);
};

/**
 * Static text scan of `nuxt.config.{ts,mjs,js,cjs}` for a signal that
 * `@nuxt/image` is configured in a way that bypasses our IPX Lambda:
 *   - `image: false`                                  → module disabled
 *   - `image: { provider: 'none' }`                   → explicit no-op
 *   - `image: { provider: 'cloudinary' | 'imgix' | … }` → third-party CDN
 *
 * `@nuxt/image` only routes through our `/_ipx/*` Lambda when the
 * provider is `'ipx'` or `'ipxStatic'`. For any other provider
 * (Cloudinary, Imgix, Cloudflare, Vercel, etc.), the
 * `<NuxtImg>` URLs go directly to that CDN and our ~50 MB IPX Lambda
 * is dead code.
 *
 * Conservative — if the user computes the provider dynamically, we
 * default to "IPX is in use" (status quo: provision the Lambda).
 */
const nuxtConfigBypassesIpx = (projectDir: string): boolean => {
  for (const ext of ['ts', 'mjs', 'js', 'cjs']) {
    const candidate = path.join(projectDir, `nuxt.config.${ext}`);
    if (!fs.existsSync(candidate)) continue;
    const source = fs.readFileSync(candidate, 'utf-8');
    if (/\bimage\s*:\s*false\b/.test(source)) return true;
    const match = source.match(
      /\bimage\s*:\s*\{[\s\S]*?\bprovider\s*:\s*['"`]([^'"`]+)['"`][\s\S]*?\}/,
    );
    if (match && !['ipx', 'ipxStatic'].includes(match[1]!)) return true;
    return false;
  }
  return false;
};

/**
 * Static text scan of `nuxt.config.{ts,mjs,js,cjs}` for the user's
 * configured IPX base URL:
 *
 *   runtimeConfig: { ipx: { baseURL: '/img-cdn' } }
 *
 * `@nuxt/image`'s IPX provider serves at `/_ipx` by default. Users can
 * override via `runtimeConfig.ipx.baseURL`. We need that value so the
 * CloudFront cache behavior + Lambda strip-prefix match what
 * `<NuxtImg>` actually generates.
 *
 * Conservative — anything dynamic (computed config, env var lookup
 * without the literal default) defaults to undefined here, and the
 * caller falls back to `/_ipx`.
 */
const findIpxBaseURL = (projectDir: string): string | undefined => {
  for (const ext of ['ts', 'mjs', 'js', 'cjs']) {
    const candidate = path.join(projectDir, `nuxt.config.${ext}`);
    if (!fs.existsSync(candidate)) continue;
    const source = fs.readFileSync(candidate, 'utf-8');
    const match = source.match(
      /\bruntimeConfig\s*:\s*\{[\s\S]*?\bipx\s*:\s*\{[\s\S]*?\bbaseURL\s*:\s*['"`]([^'"`]+)['"`]/,
    );
    return match ? match[1] : undefined;
  }
  return undefined;
};

/**
 * Read `@nuxt/image`'s `image.domains` allowlist from nuxt.config so the IPX
 * Lambda can be configured to fetch remote source images (it default-denies
 * remote fetches when the allowlist is empty, to avoid an SSRF primitive).
 *
 * `<NuxtImg src="https://host/…">` only optimizes a remote image when its
 * hostname is in `image.domains`; we mirror that allowlist into
 * `manifest.imageOptimization.domains` → the Lambda's `IMAGE_ALLOWED_HOSTNAMES`
 * env. Conservative: matches a literal `domains: ['a', 'b']` array of string
 * literals; anything dynamic yields an empty list (fails closed).
 */
const findNuxtImageDomains = (projectDir: string): string[] => {
  for (const ext of ['ts', 'mjs', 'js', 'cjs']) {
    const candidate = path.join(projectDir, `nuxt.config.${ext}`);
    if (!fs.existsSync(candidate)) continue;
    const source = fs.readFileSync(candidate, 'utf-8');
    // Match `image: { … domains: [ … ] … }`. Keep it tight: the `domains`
    // array must appear within an `image:` block.
    const block = source.match(/\bimage\s*:\s*\{[\s\S]*?\}/);
    const scope = block ? block[0] : source;
    const arr = scope.match(/\bdomains\s*:\s*\[([^\]]*)\]/);
    if (!arr) return [];
    return [...arr[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  }
  return [];
};

/**
 * Build the DeployManifest from a known-good `.output/` layout.
 */
const buildManifest = (input: {
  preset: string;
  serverDir: string;
  publicDir: string;
  routeRules: Record<string, NitroRouteRule>;
  awsLambdaStreaming: boolean;
  imageOptBundle?: string;
  /**
   * Path the IPX Lambda is mounted at. Defaults to `/_ipx` when
   * `imageOptBundle` is set; user override comes from
   * `runtimeConfig.ipx.baseURL` in nuxt.config.
   */
  ipxBaseURL?: string;
  /** `@nuxt/image` `image.domains` → IPX remote-source allowlist. */
  imageDomains?: string[];
  /** Normalized `app.baseURL` (Nuxt), if set. Maps to `manifest.basePath`. */
  basePath?: string;
}): DeployManifest => {
  const {
    preset,
    serverDir,
    publicDir,
    routeRules,
    awsLambdaStreaming,
    imageOptBundle,
    ipxBaseURL,
    imageDomains,
    basePath,
  } = input;

  // Default the IPX base URL to @nuxt/image's `/_ipx` convention.
  // `findIpxBaseURL` already returns undefined when the user didn't
  // override.
  const effectiveIpxBaseURL = ipxBaseURL ?? '/_ipx';

  const compute: Record<string, ComputeResource> = {
    default: presetToCompute(preset, serverDir, awsLambdaStreaming),
  };

  const manifest: DeployManifest = {
    version: 1,
    compute,
    staticAssets: {
      directory: publicDir,
      // Nuxt content-hashes everything under `_nuxt/`; HTML, public/,
      // and prerendered routes (e.g. `/about/index.html`) live elsewhere
      // and must NOT be marked immutable.
      immutablePaths: ['_nuxt/*'],
    },
    routes: buildRoutes(
      publicDir,
      routeRules,
      !!imageOptBundle,
      effectiveIpxBaseURL,
    ),
  };

  const redirects = buildRedirects(routeRules);
  if (redirects.length > 0) {
    manifest.redirects = redirects;
  }

  const rewrites = buildRewrites(routeRules);
  if (rewrites.length > 0) {
    manifest.rewrites = rewrites;
  }

  const headers = buildHeaders(routeRules);
  if (headers.length > 0) {
    manifest.headers = headers;
  }

  // Nuxt `app.baseURL` → cross-framework `manifest.basePath`. The L3
  // prefixes every CloudFront behavior with it (and 308-redirects the bare
  // root to `/<base>/`), matching the Next/Astro path.
  if (basePath) {
    manifest.basePath = basePath;
    process.stdout.write(
      `🔗 Detected Nuxt app.baseURL=${basePath}; CloudFront behaviors will be prefixed.\n`,
    );
  }

  // If any route rule uses SWR / ISR / cache, ask the L3 to provision
  // a shared S3-backed cache. Nitro's `useStorage('cache')` reads/writes
  // through the S3 cache plugin we injected into the build.
  if (usesIsrFeatures(routeRules)) {
    manifest.cache = {
      computeResource: 'default',
      driver: 'nitro-s3',
    };
  }

  // Image optimization Lambda — separate compute so sharp's native
  // binary doesn't bloat the SSR Lambda zip.
  if (imageOptBundle) {
    manifest.imageOptimization = {
      bundle: imageOptBundle,
      handler: 'index.handler',
      // @nuxt/image's defaults; user can override via nuxt.config but
      // the IPX runtime accepts any size requested in the URL anyway.
      formats: ['webp', 'avif'],
      sizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
      // @nuxt/image `image.domains` → IPX Lambda remote-source allowlist
      // (IMAGE_ALLOWED_HOSTNAMES). Empty = default-deny (local images only).
      ...(imageDomains && imageDomains.length > 0
        ? { domains: imageDomains }
        : {}),
      baseURL: effectiveIpxBaseURL,
      // Forward the user-configured base URL into the Lambda so its
      // prefix-stripping regex matches whatever path CloudFront
      // routes here. Default `/_ipx` works without an explicit env.
      ...(effectiveIpxBaseURL !== '/_ipx'
        ? { environment: { IPX_BASE_URL: effectiveIpxBaseURL } }
        : {}),
    };
  }

  return manifest;
};

/**
 * Returns true if any route rule uses an ISR / SWR / cache feature
 * that needs a shared cache backend to actually work across Lambda
 * containers.
 *
 * Treat falsy values as "not requesting caching". Nuxt's framework
 * defaults emit `'/__nuxt_error': { cache: false }` on every project,
 * so a presence-only check tripped on every vanilla Nuxt deploy and
 * provisioned an unused S3 cache bucket.
 */
const usesIsrFeatures = (
  routeRules: Record<string, NitroRouteRule>,
): boolean => {
  return Object.values(routeRules).some((rule) => {
    const raw = rule as Record<string, unknown>;
    // `swr` and `isr` aren't typed on our local NitroRouteRule yet —
    // Nitro emits any of these three for ISR semantics. Truthy values
    // mean "use cache" (e.g. `swr: 60`, `cache: { swr: true }`); falsy
    // values (`cache: false`, `swr: 0`) mean the rule explicitly opts
    // out and shouldn't trigger cache provisioning.
    return Boolean(rule.cache) || Boolean(raw.swr) || Boolean(raw.isr);
  });
};

/**
 * Map a Nitro preset (+ relevant config flags) to the right
 * ComputeResource shape.
 */
const presetToCompute = (
  preset: string,
  serverDir: string,
  awsLambdaStreaming: boolean,
): ComputeResource => {
  // Plain Node HTTP server presets — front via the Lambda Web Adapter.
  if (preset === 'node-server' || preset === 'node') {
    return {
      type: 'http-server',
      bundle: serverDir,
      entrypoint: 'index.mjs',
      port: 3000,
      placement: 'regional',
      runtime: 'nodejs20.x',
    };
  }

  // Default: aws-lambda preset. Streaming is opt-in via
  // `nitro.awsLambda.streaming: true` in the user's config; Nitro
  // emits a different runtime entry that wraps the handler with
  // `awslambda.streamifyResponse`.
  return {
    type: 'handler',
    bundle: serverDir,
    handler: 'index.handler',
    placement: 'regional',
    streaming: awsLambdaStreaming,
    runtime: 'nodejs20.x',
  };
};

/**
 * Walk `.output/public/` and emit static routes for prerendered output,
 * then append a catch-all `/* → default` for SSR.
 * @param publicDir Absolute path to `.output/public/` for the build.
 * @param routeRules Merged Nitro route rules (user + framework defaults).
 * @param hasImageOptimization Whether an image-opt Lambda is being
 *   provisioned. Controls emission of the IPX cache behavior.
 * @param ipxBaseURL Path the image-opt Lambda is mounted at when
 *   `hasImageOptimization` is true. Defaults to `/_ipx`; users override
 *   via `runtimeConfig.ipx.baseURL` in nuxt.config.
 */
const buildRoutes = (
  publicDir: string,
  routeRules: Record<string, NitroRouteRule>,
  hasImageOptimization: boolean,
  ipxBaseURL: string,
): RouteBehavior[] => {
  const routes: RouteBehavior[] = [];
  const seenPatterns = new Set<string>();

  const addRoute = (route: RouteBehavior): void => {
    if (seenPatterns.has(route.pattern)) return;
    routes.push(route);
    seenPatterns.add(route.pattern);
  };

  // Image optimization route must come BEFORE the catch-all and
  // before any /<dir>/* match so the IPX path lands on the dedicated
  // Lambda. The L3 routes target='image-optimization' to a separate
  // compute resource (it's a reserved target).
  if (hasImageOptimization) {
    addRoute({
      pattern: `${ipxBaseURL.replace(/\/+$/, '')}/*`,
      target: 'image-optimization',
    });
  }

  if (fs.existsSync(publicDir)) {
    // Everything in `.output/public/` is, by definition, a static
    // asset. Walk the top level and route each entry to S3:
    //   - directory  → `/<name>/*`
    //   - file       → `/<name>`
    // This catches both framework-emitted dirs (`_nuxt/`, `_build/`,
    // `assets/`) and user-supplied ones (anything dropped into
    // `public/`, e.g. `public/img/`, `public/fonts/`).
    for (const entry of fs.readdirSync(publicDir, { withFileTypes: true })) {
      // Skip prerendered HTML routes — handled below as `<route>/*`.
      if (entry.isFile() && entry.name.endsWith('.html')) continue;
      const pattern = entry.isDirectory()
        ? `/${entry.name}/*`
        : `/${entry.name}`;
      addRoute({ pattern, target: 'static' });
    }

    // Walk for prerendered HTML pages and emit a *subtree* route for each.
    //
    // We deliberately do NOT emit a bare `/<route>` static route — the
    // CloudFront build-ID rewrite Function only appends `index.html` when
    // the URI ends with `/`, so `/about` would resolve to the S3 key
    // `builds/{id}/about` (no such object → 403). Instead we route
    // `/<route>/*` to S3 (so `_payload.json` and other sibling assets the
    // framework prefetches resolve), and let the bare `/<route>` flow
    // through the catch-all to the SSR Lambda, which re-renders the page
    // from the bundled component on demand.
    for (const htmlFile of walkHtmlFiles(publicDir)) {
      const rel = path.relative(publicDir, htmlFile).replace(/\\/g, '/');
      const urlPath = htmlFileToUrlPath(rel);
      if (urlPath === '/') continue;
      addRoute({ pattern: `${urlPath}/*`, target: 'static' });
    }
  }

  // Honour route rules with `prerender: true` even if the build hasn't
  // emitted a file at that path yet. We emit the subtree pattern only
  // (e.g. `/about/*` not bare `/about`) for the same reason the
  // filesystem walk above does — the build-ID rewriter can't resolve a
  // bare prerendered path to its index.html.
  for (const [routePattern, rule] of Object.entries(routeRules)) {
    if (rule.prerender) {
      const normalized = normalizeRulePattern(routePattern);
      const subtree = normalized.endsWith('/*')
        ? normalized
        : `${normalized}/*`;
      addRoute({ pattern: subtree, target: 'static' });
    }
  }

  // Catch-all SSR route always last.
  addRoute({ pattern: '/*', target: 'default' });

  return routes;
};

const walkHtmlFiles = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return [];
  return fg.sync('**/*.html', { cwd: dir, absolute: true });
};

/**
 * Convert a relative `.html` path into a CloudFront route pattern.
 * `about/index.html` → `/about`
 * `index.html` → `/`
 * `blog/post.html` → `/blog/post`
 */
const htmlFileToUrlPath = (relPath: string): string => {
  let urlPath = '/' + relPath.replace(/\\/g, '/').replace(/\.html$/, '');
  urlPath = urlPath.replace(/\/index$/, '');
  return urlPath === '' ? '/' : urlPath;
};

/**
 * Normalize a route-rule pattern (e.g. `/blog/**`) to a CloudFront cache
 * behavior pattern (e.g. `/blog/*`).
 */
const normalizeRulePattern = (pattern: string): string => {
  return pattern.replace(/\*\*/g, '*');
};

/**
 * Translate `proxy` route rules into manifest Rewrites.
 *
 * `routeRules: { '/api/external/**': { proxy: 'https://upstream.example/**' } }`
 * is Nitro's upstream-proxy form — Nitro's runtime forwards the request
 * to the destination URL preserving method/body/headers. Without this
 * lift, every proxied request burns an SSR Lambda invocation just to
 * relay; with it, CloudFront routes directly to the upstream origin.
 *
 * The L3 doesn't yet consume `manifest.rewrites[]` for edge-optimized
 * upstream proxying — that requires per-pattern `HttpOrigin` provisioning +
 * a CloudFront Function origin-rewrite step. Until then the rule still WORKS:
 * the proxied path matches the catch-all `/* → default` route, so the bundled
 * Nitro runtime relays it to the upstream from inside the SSR Lambda. The
 * adapter emits the field (so the L3 can warn that it's not edge-optimized and
 * so future wiring can consume it), but the app deploys and proxies correctly.
 */
const buildRewrites = (
  routeRules: Record<string, NitroRouteRule>,
): NonNullable<DeployManifest['rewrites']> => {
  const out: NonNullable<DeployManifest['rewrites']> = [];
  for (const [source, rule] of Object.entries(routeRules)) {
    if (!rule.proxy) continue;
    const dest = typeof rule.proxy === 'string' ? rule.proxy : rule.proxy.to;
    out.push({
      source: normalizeRulePattern(source),
      destination: dest,
    });
  }
  return out;
};

/**
 * Translate `redirect` route rules into manifest Redirects.
 */
const buildRedirects = (
  routeRules: Record<string, NitroRouteRule>,
): NonNullable<DeployManifest['redirects']> => {
  const out: NonNullable<DeployManifest['redirects']> = [];
  for (const [source, rule] of Object.entries(routeRules)) {
    if (!rule.redirect) continue;
    const dest =
      typeof rule.redirect === 'string' ? rule.redirect : rule.redirect.to;
    const statusCode =
      typeof rule.redirect === 'object' && rule.redirect.statusCode
        ? rule.redirect.statusCode
        : 302;
    out.push({
      source: normalizeRulePattern(source),
      destination: dest,
      statusCode,
    });
  }
  return out;
};

/**
 * Translate `headers`, `cors`, and `cache.maxAge` route rules into
 * manifest CustomHeaders.
 *
 * Multiple Nitro route-rule fields can produce headers for the same
 * source pattern. Merge them with user-declared `headers` winning over
 * auto-emitted ones so the user can always override the cors/cache
 * defaults if they need to.
 *
 *  - `headers: { ... }` lifts as-is.
 *  - `cors: true` emits the same Access-Control-* set as Nitro's runtime
 *    middleware so behavior matches when the rule fires at the edge.
 *  - `cache.maxAge: N` emits `Cache-Control: public, max-age=N, s-maxage=N`
 *    so CloudFront edge-caches the response for N seconds.
 *  - SWR rules (`cache: { swr: true, maxAge: N }`) emit
 *    `public, s-maxage=N, stale-while-revalidate=…` (no `max-age`) so the
 *    edge serves stale-while-revalidating instead of hard-caching. Background
 *    regeneration still relies on `manifest.cache` provisioning.
 */
const buildHeaders = (
  routeRules: Record<string, NitroRouteRule>,
): NonNullable<DeployManifest['headers']> => {
  const merged = new Map<string, Record<string, string>>();
  const recordFor = (source: string): Record<string, string> => {
    const key = normalizeRulePattern(source);
    let rec = merged.get(key);
    if (!rec) {
      rec = {};
      merged.set(key, rec);
    }
    return rec;
  };
  for (const [source, rule] of Object.entries(routeRules)) {
    // 1. `cors: true` — emit the standard Access-Control-* headers.
    //    Same allow-origin/allow-methods/allow-headers set Nitro's runtime
    //    middleware applies; `cors: false` is a no-op (default behavior).
    if (rule.cors === true) {
      const corsHeaders = recordFor(source);
      // eslint-disable-next-line @typescript-eslint/naming-convention
      corsHeaders['Access-Control-Allow-Origin'] = '*';
      // eslint-disable-next-line @typescript-eslint/naming-convention
      corsHeaders['Access-Control-Allow-Methods'] =
        'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD';
      // eslint-disable-next-line @typescript-eslint/naming-convention
      corsHeaders['Access-Control-Allow-Headers'] =
        'Content-Type, Authorization';
    }
    // 2. `cache.maxAge: N` — translate to a public Cache-Control.
    const maxAge = rule.cache?.maxAge;
    if (typeof maxAge === 'number' && maxAge > 0 && Number.isFinite(maxAge)) {
      const cacheHeaders = recordFor(source);
      // SWR (`cache: { swr: true, maxAge: N }`, or the `swr: N` shorthand
      // Nitro normalizes into it) means "serve fresh for N seconds, then
      // serve STALE while revalidating in the background" — NOT "cache hard
      // for N seconds". Emit `s-maxage=N, stale-while-revalidate=…` and NO
      // `max-age`, so the browser always revalidates while CloudFront serves
      // the stale edge copy. A plain `max-age=N` would let browsers pin the
      // stale response with no revalidation — the opposite of SWR.
      const isSwr =
        rule.cache?.swr === true ||
        Boolean((rule as Record<string, unknown>).swr);
      const value = isSwr
        ? `public, s-maxage=${maxAge}, stale-while-revalidate=${SWR_STALE_WINDOW_SECONDS}`
        : `public, max-age=${maxAge}, s-maxage=${maxAge}`;
      // eslint-disable-next-line @typescript-eslint/naming-convention
      cacheHeaders['Cache-Control'] = value;
    }
    // 3. User-declared `headers: { ... }` wins over the auto-emit
    //    above. Validate Cache-Control values so invalid directives
    //    fail at adapter time rather than silently passing through.
    if (rule.headers && Object.keys(rule.headers).length > 0) {
      for (const [name, value] of Object.entries(rule.headers)) {
        if (name.toLowerCase() === 'cache-control') {
          validateCacheControl(value, `route ${source} (Nitro routeRules)`);
        }
      }
      Object.assign(recordFor(source), rule.headers);
    }
  }
  const out: NonNullable<DeployManifest['headers']> = [];
  for (const [source, headers] of merged) {
    if (Object.keys(headers).length === 0) continue;
    out.push({ source, headers });
  }
  return out;
};

/**
 * Patch Nitro's bundled aws-lambda handler so it falls through to REST API
 * (payload v1) fields when the v2 fields are undefined:
 *   - withQuery(event.rawPath, …) → event.rawPath || event.path
 *   - event.requestContext?.http?.method → || event.requestContext?.httpMethod
 *
 * The handler can land in different chunks depending on Nitro's chunking
 * (typically `chunks/nitro/nitro.mjs` on POSIX, `chunks/_/nitro.mjs` or
 * `index.mjs` on Windows due to a Nitro v2 chunk-name prefix-match bug).
 * Walk every `.mjs` under <serverDir> and patch wherever the patterns
 * appear. Idempotent — only rewrites files whose contents change.
 * @internal
 */
export const patchNitroHandlerForApiGateway = (serverDir: string): void => {
  // The aws-lambda preset's request-shape calls (`event.rawPath`,
  // `event.requestContext?.http?.method`) live in Nitro's compiled
  // `nitro.mjs` on Linux/macOS. On Windows, Nitro v2's `getChunkName`
  // prefix match (`id.startsWith(runtimeDir)`) fails because Rollup
  // module ids use POSIX separators while `runtimeDir` uses OS separators
  // — the runtime ends up grouped into `index.mjs` or another chunk.
  // Walk every `.mjs` under serverDir and patch wherever the patterns
  // appear; idempotent because we only rewrite when a regex matches.

  const rawPathRe = /withQuery\(\s*event\.rawPath\s*,\s*query\s*\)/g;
  const rawPathReplacement = 'withQuery(event.rawPath || event.path, query)';
  // Negative lookahead so we don't re-wrap a method ref that already has the
  // `|| event.requestContext?.httpMethod` fallthrough — keeps the patch
  // idempotent across repeat invocations.
  const methodRe =
    /event\.requestContext\?\.http\?\.method(?!\s*\|\|\s*event\.requestContext\?\.httpMethod)/g;
  const methodReplacement =
    '(event.requestContext?.http?.method || event.requestContext?.httpMethod)';
  // Nitro's aws-lambda preset decodes the API Gateway base64 wrapper and
  // immediately re-encodes the bytes as a UTF-8 string before handing them
  // to h3, mangling any non-text payload (file uploads, binary blobs). A
  // 1 MB random POST round-trips lossy: server reports ~1.81 MB with a
  // different sha256. Strip the `.toString("utf8")` so the Buffer is passed
  // through unchanged. h3's request layer accepts Buffer bodies natively
  // (`readRawBody` returns the Buffer; `readBody` parses by content-type).
  const bodyDecodeRe =
    /Buffer\.from\(event\.body\s*\|\|\s*""\s*,\s*"base64"\)\.toString\("utf8"\)/g;
  const bodyDecodeReplacement = 'Buffer.from(event.body || "", "base64")';

  let totalPatches = 0;
  const patchedFiles: string[] = [];

  if (!fs.existsSync(serverDir)) return;
  const mjsFiles = fg.sync('**/*.mjs', { cwd: serverDir, absolute: true });
  for (const full of mjsFiles) {
    const src = fs.readFileSync(full, 'utf-8');
    let patches = 0;
    let next = src;
    if (rawPathRe.test(next)) {
      next = next.replace(rawPathRe, rawPathReplacement);
      patches++;
    }
    if (methodRe.test(next)) {
      next = next.replace(methodRe, methodReplacement);
      patches++;
    }
    if (bodyDecodeRe.test(next)) {
      next = next.replace(bodyDecodeRe, bodyDecodeReplacement);
      patches++;
    }
    if (patches > 0) {
      fs.writeFileSync(full, next, 'utf-8');
      totalPatches += patches;
      patchedFiles.push(path.relative(serverDir, full));
    }
  }

  if (totalPatches === 0) {
    // Zero patches is NOT an error. Two benign causes:
    //   1. Nitro v3 (and any release with a REST-compatible request shape)
    //      needs no patch — upstream reads both v1/v2 fields, so there's
    //      nothing to rewrite. Verified working with no patching.
    //   2. The handler is already patched (idempotent re-run).
    // A genuine signature drift on an OLDER Nitro that DID need patching is
    // surfaced separately by `warnIfNitroOutOfRange` (the installed nitropack
    // would be outside the verified range). We deliberately do not throw here
    // — doing so would break the working v3 path.
    process.stderr.write(
      `ℹ️  Nitro handler patch found nothing to change under ${serverDir} — ` +
        `expected on Nitro v3+ (no patch needed) or a re-run. If you see broken ` +
        `routing or corrupt binary POSTs on an older Nitro, check the nitropack ` +
        `version against the verified range.\n`,
    );
    return;
  }

  process.stderr.write(
    `\u{1F527} Patched bundled Nitro aws-lambda handler for API Gateway REST API ` +
      `(${totalPatches} edits across ${patchedFiles.length} file(s): ${patchedFiles.join(
        ', ',
      )}).\n`,
  );
};
