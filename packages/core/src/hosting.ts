// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import {
  AllowedMethods,
  CachePolicy,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  HostingConstruct,
  generateBuildId,
  type HostingConstructProps,
  type HostingDomainConfig,
  type HostingWafConfig,
  type SkewProtectionConfig,
} from '@aws-blocks/hosting/constructs';
import {
  detectFramework,
  getAdapter,
  normalizeBasePath,
  type FrameworkAdapterFn,
} from '@aws-blocks/hosting/adapters';
import type {
  DeployManifest,
  RouteBehavior,
  FrameworkType,
} from '@aws-blocks/hosting';
import { BLOCKS_RPC_PREFIX, BLOCKS_AUTH_PREFIX } from './constants.js';
import { BLOCKS_SANDBOX_DIR } from './common/constants.js';
import { registerConfig } from './cdk/config-registry.js';
import { getRegisteredRoutes } from './raw-route.js';

// ─── Public types ────────────────────────────────────────────────

/**
 * Lambda compute configuration for SSR frameworks.
 *
 * Controls the memory, timeout, concurrency, and log retention of the
 * server-side rendering Lambda function.
 *
 * @example
 * ```ts
 * compute: {
 *   memorySize: 1024,
 *   timeout: Duration.seconds(30),
 *   reservedConcurrency: 10,
 * }
 * ```
 */
export type ComputeConfig = {
  /** Lambda memory size in MB. Default: 512. */
  memorySize?: number;
  /**
   * Lambda timeout. Default: 30 seconds.
   *
   * Accepts either a `cdk.Duration` object (e.g. `Duration.seconds(30)`)
   * or a plain number of seconds (e.g. `30`). Both are equivalent.
   *
   * @example
   * ```ts
   * // Either form works:
   * timeout: Duration.seconds(30)
   * timeout: 30
   * ```
   */
  timeout?: cdk.Duration | number;
  /** Reserved concurrent executions for the SSR Lambda. Default: undefined (no reservation). */
  reservedConcurrency?: number;
  /**
   * Overrides for the image-optimization Lambda.
   *
   * `reservedConcurrency` defaults to undefined (no reservation). It is left
   * unreserved so deploys succeed on fresh AWS accounts, whose default
   * account-level unreserved-concurrency limit is 10 — reserving any
   * concurrency there can drop the account below its required minimum and
   * cause Lambda to reject the stack with a 400. Set this only if you have
   * headroom and want to cap image-opt throughput.
   *
   * @example
   * ```ts
   * compute: {
   *   imageOptimization: { reservedConcurrency: 5 },
   * }
   * ```
   */
  imageOptimization?: {
    /** Reserved concurrent executions. Default: undefined (no reservation). */
    reservedConcurrency?: number;
  };
  /** CloudWatch log retention for the SSR Lambda. Default: TWO_WEEKS. */
  logRetention?: cdk.aws_logs.RetentionDays;
};

export type { FrameworkType, HostingDomainConfig, HostingWafConfig, SkewProtectionConfig };

/**
 * Structural interface for the Blocks backend stack.
 *
 * Accepts any object that exposes an `apiUrl` — typically a {@link BlocksStack}
 * instance but kept structural so Hosting doesn't depend on the concrete class.
 */
export interface BlocksStackApi {
  /** Fully-qualified API Gateway URL (e.g. `https://{id}.execute-api.{region}.amazonaws.com/{stage}/aws-blocks`). */
  readonly apiUrl: string;
}

/**
 * Blocks-specific configuration for the {@link Hosting} construct.
 *
 * Wraps the L3 {@link HostingConstruct} with Blocks conventions:
 *   • Runs the build command during CDK synth (optional)
 *   • Auto-detects the framework (Next.js / SPA / static)
 *   • Deploys `.blocks-sandbox/config.json` for client-side config loading
 *   • Injects `BLOCKS_API_URL` + `BLOCKS_CONFIG` env vars into compute functions
 *   • When `api` is provided, adds CloudFront behaviors to proxy API traffic
 *     through the same domain (single-origin architecture)
 */
export interface HostingProps {
  // ── Build ──────────────────────────────────────────────────────
  /** Absolute or relative path to the frontend app root directory. */
  root: string;

  /**
   * Shell command to build the frontend (e.g. `'npm run build'`).
   * When provided, it is executed during CDK synth with `BLOCKS_API_URL`
   * injected into the environment.
   * Omit if the app is already pre-built.
   */
  buildCommand?: string;

  /**
   * Framework type: `'nextjs'`, `'spa'`, or `'static'`.
   * Auto-detected from `package.json` when omitted.
   */
  framework?: FrameworkType;

  /**
   * Path to the build output directory (e.g. `'dist'` or `'.next'`).
   * Auto-detected based on framework when omitted.
   */
  buildOutputDir?: string;

  /** Supply a custom adapter when using an unsupported framework. */
  customAdapter?: FrameworkAdapterFn;

  /**
   * URL prefix the whole site is served under (Next.js `basePath`, Astro
   * `base`, Nuxt `app.baseURL`). When set, CloudFront behaviors are prefixed
   * with it and the bare root issues a 308 redirect to `/<basePath>/`.
   *
   * Declaring it here is the recommended source of truth: the value is
   * caller-provided rather than reverse-engineered from build output, so it
   * can't drift with framework/bundler internals. When omitted, the adapter
   * falls back to detecting the framework's own base-path config from the
   * build output.
   *
   * Format: leading slash, no trailing slash (e.g. `'/app'`). A trailing
   * slash or bare `'/'` is normalized/ignored.
   *
   * @example
   * ```ts
   * new Hosting(stack, 'Web', { root, framework: 'nuxt', basePath: '/app' });
   * ```
   */
  basePath?: string;

  // ── Blocks backend integration ────────────────────────────────────
  /**
   * The Blocks backend stack (or any object with `apiUrl`).
   *
   * When provided, Hosting creates CloudFront behaviors that proxy API
   * requests through the same domain as the frontend — enabling relative
   * URL access (`/aws-blocks/...`) without CORS.
   *
   * Omit when deploying a static-only site with no backend.
   */
  api?: BlocksStackApi;

  /**
   * Additional backend configuration to include in config.json.
   * Merged with apiUrl to produce the final config.
   *
   * ⚠️ WARNING: These values will be publicly accessible at /.blocks-sandbox/config.json
   * and in the BLOCKS_CONFIG Lambda environment variable. Do NOT include secrets,
   * API keys, or sensitive configuration here.
   */
  backendConfig?: Record<string, unknown>;

  // ── Infrastructure options ─────────────────────────────────────
  /** Lambda compute configuration for SSR frameworks. */
  compute?: ComputeConfig;

  /** Custom domain configuration. */
  domain?: HostingDomainConfig;

  /** WAF protection configuration. */
  waf?: HostingWafConfig;

  /** Retain the S3 bucket when the stack is deleted. Default: false. */
  retainOnDelete?: boolean;

  /** Custom Content-Security-Policy header value. */
  contentSecurityPolicy?: string;

  /** CloudFront price class. Default: PRICE_CLASS_100. */
  priceClass?: cdk.aws_cloudfront.PriceClass;

  /**
   * Geo-restriction configuration for the CloudFront distribution.
   *
   * @example
   * ```ts
   * geoRestriction: { type: 'whitelist', countries: ['US', 'CA', 'GB'] }
   * ```
   */
  geoRestriction?: {
    type: 'whitelist' | 'blacklist';
    countries: string[];
  };

  /**
   * Overrides for the adjustable AWS Service Quotas the CloudFront
   * distribution draws on. Each field maps to a named AWS quota you can
   * request an increase on:
   *
   *   - `cacheBehaviors` — "Cache behaviors per distribution" (default 25).
   *     Consumed by routed paths, prerendered pages, per-pattern header
   *     rules, assetPrefix, and the error-page behavior.
   *   - `edgeFunctions` — Lambda@Edge associations per distribution
   *     (default 25). Consumed by `runtime: 'edge'` routes.
   *   - `headerPolicies` — "Response headers policies per AWS account"
   *     (default 20, account-wide).
   *
   * Omitted fields use the AWS default. Set a field ONLY to match a quota
   * increase AWS has actually granted — synth cannot verify your real quota,
   * so an over-set value does not raise the AWS ceiling; it just moves the
   * failure from a clear synth error to an opaque CloudFormation rollback.
   *
   * @example
   * ```ts
   * // After AWS grants "Cache behaviors per distribution" = 50:
   * new Hosting(stack, 'Web', { root, quotas: { cacheBehaviors: 50 } });
   * ```
   */
  quotas?: {
    cacheBehaviors?: number;
    edgeFunctions?: number;
    headerPolicies?: number;
    /**
     * Max chunks per KVS edge route table (routes / redirects / headers);
     * ~25 entries per chunk, default 64 (≈1600 entries). Not an AWS quota —
     * a self-imposed guard (KVS ≤5 MB + the edge function reads chunks
     * sequentially per request). Raise only after measuring edge-function
     * compute headroom (e.g. a very large `trailingSlash: true` site with
     * many canonical-form redirects); lowering it fails synth sooner.
     * @default 64
     */
    maxRouteChunks?: number;
  };

  /**
   * Build cache configuration. When enabled, provisions an S3 bucket for
   * framework build caches (e.g. Next.js .next/cache) and exports the bucket
   * name as a CfnOutput. Reduces cold-build times in CI.
   *
   * @example
   * ```ts
   * buildCache: { enabled: true }
   * ```
   */
  buildCache?: {
    enabled: boolean;
    /** BYO S3 bucket for build cache storage. Creates one if not provided. */
    bucket?: cdk.aws_s3.IBucket;
  };

  /**
   * Custom error pages served by CloudFront for 404/500 responses.
   * Paths are relative to the project root and must point to HTML files
   * present in the build output.
   *
   * Note: Custom error pages are incompatible with SPAs that use client-side
   * routing. Error pages disable SPA fallback mode, which breaks deep linking.
   * Use this feature for static sites and SSR apps only.
   *
   * @example
   * ```ts
   * errorPages: { notFound: '/404.html', serverError: '/500.html' }
   * ```
   */
  errorPages?: {
    /** Path to a custom 404 HTML file (relative to project root). */
    notFound?: string;
    /** Path to a custom 500 HTML file (relative to project root). */
    serverError?: string;
  };

  /**
   * CloudFront access logging configuration.
   * When enabled, access logs are written to a dedicated S3 bucket.
   */
  logging?: {
    /** Enable CloudFront access logging. */
    enabled: boolean;
    /** Days to retain access logs. Default: 90. */
    retentionDays?: number;
  };

  /**
   * CloudWatch alarms for hosting infrastructure. When enabled, wires
   * CloudFront 5xx, Lambda error/throttle, and revalidation DLQ alarms
   * to an SNS topic.
   *
   * @default { enabled: true }
   */
  monitoring?: {
    enabled?: boolean;
    /** ARN of an existing SNS topic to send alarm actions to. */
    snsTopicArn?: string;
  };

  /**
   * Cookie-based skew protection to prevent asset mismatches during
   * rolling deployments. When enabled, returning users are pinned to
   * the build they started their session on.
   *
   * @default { enabled: true }
   */
  skewProtection?: SkewProtectionConfig;
}

// ─── Default build output directories per framework ──────────────

const DEFAULT_BUILD_DIRS: Record<string, string> = {
  nextjs: '.next',
  sveltekit: 'build',
  spa: 'dist',
  static: 'dist',
};

// ─── Construct ───────────────────────────────────────────────────

/**
 * Blocks hosting construct backed by the L3 {@link HostingConstruct}.
 *
 * Supports SPA, static sites, and Next.js SSR out of the box.
 * When the `api` prop is provided, CloudFront behaviors are added to proxy
 * `/aws-blocks/*` (and any registered {@link RawRoute} paths) through the
 * same domain — enabling a single-origin architecture with no CORS issues.
 *
 * @example SPA deployment with API
 * ```ts
 * new Hosting(stack, 'Web', {
 *   root: join(__dirname, '..'),
 *   buildCommand: 'npm run build',
 *   api: blocksStack,
 * });
 * ```
 *
 * @example Next.js SSR deployment
 * ```ts
 * new Hosting(stack, 'Web', {
 *   root: join(__dirname, '..'),
 *   buildCommand: 'npm run build',
 *   framework: 'nextjs',
 *   api: blocksStack,
 *   compute: { memorySize: 1024, timeout: Duration.seconds(30) },
 * });
 * ```
 *
 * @example Static-only site (no backend)
 * ```ts
 * new Hosting(stack, 'Web', {
 *   root: join(__dirname, '..'),
 *   buildCommand: 'npm run build',
 * });
 * ```
 */
export class Hosting extends Construct {
  /** The S3 bucket storing static assets. */
  public readonly bucket: cdk.aws_s3.Bucket;
  /** The CloudFront distribution. */
  public readonly distribution: cdk.aws_cloudfront.Distribution;
  /** The public URL of the deployed site (https://...). */
  public readonly url: string;
  /** The primary SSR/compute Lambda function (first compute resource, if any). */
  public readonly ssrFunction?: cdk.aws_lambda.Function;
  /** S3 bucket for framework build caches (present when `buildCache.enabled` is true). */
  public readonly buildCacheBucket?: cdk.aws_s3.Bucket;
  /** SNS topic for hosting CloudWatch alarms (present when `monitoring.enabled` is true). */
  public readonly monitoringTopic?: cdk.aws_sns.ITopic;

  constructor(scope: Construct, id: string, props: HostingProps) {
    super(scope, id);

    const root = resolve(props.root);

    // ── 1. Detect framework ──────────────────────────────────────
    const framework = props.framework ?? detectFramework(root);

    // ── 2. Optionally run the build ──────────────────────────────
    if (props.buildCommand) {
      console.log(`🏗️  Building frontend (${framework}): ${props.buildCommand}`);
      const apiUrl = props.api?.apiUrl;
      // Strip CDK's --conditions=cdk from NODE_OPTIONS to prevent it
      // from breaking frontend builds (e.g., Next.js webpack module resolution).
      const nodeOptions = (process.env.NODE_OPTIONS || '')
        .split(/\s+/)
        .filter(opt => opt !== '--conditions=cdk')
        .join(' ');
      const buildEnv = { ...process.env, NODE_OPTIONS: nodeOptions };
      try {
        execSync(props.buildCommand, {
          cwd: root,
          stdio: 'inherit',
          env: {
            ...buildEnv,
            ...(apiUrl ? { BLOCKS_API_URL: apiUrl } : {}),
          },
        });
      } catch (error) {
        throw new Error(
          `Frontend build failed: ${props.buildCommand}\n` +
          `Ensure the build command is correct and all dependencies are installed.`,
        );
      }
    }

    // ── 3. Resolve build output dir (for validation only) ────────
    const buildOutputDir = props.buildOutputDir;

    const expectedOutputDir = buildOutputDir
      ? resolve(root, buildOutputDir)
      : resolve(root, DEFAULT_BUILD_DIRS[framework] ?? 'dist');

    if (!existsSync(expectedOutputDir)) {
      throw new Error(
        `Build output directory not found: ${expectedOutputDir}\n` +
        `Provide a buildCommand or ensure the directory exists before synthesis.`,
      );
    }

    // ── 4. Run framework adapter → DeployManifest ────────────────
    //    For Next.js with buildCommand: the construct already ran `next build`
    //    with BLOCKS_API_URL in the env. OpenNext will re-run it but Next.js
    //    caches aggressively so it's fast. We still set BLOCKS_API_URL in the
    //    process env so OpenNext's build also has access to it.
    if (props.api?.apiUrl) {
      process.env.BLOCKS_API_URL = props.api.apiUrl;
    }
    const adapter = props.customAdapter ?? getAdapter(framework, buildOutputDir);
    const manifest: DeployManifest = adapter(root);

    // ── 4b. Ensure buildId is set on the manifest ────────────────
    if (!manifest.buildId) {
      manifest.buildId = generateBuildId();
    }

    // ── 4b'. basePath: prop is the source of truth ───────────────
    //    A caller-declared `basePath` overrides whatever the adapter
    //    detected from build output. This is the robust path: the value
    //    is provided rather than reverse-engineered from framework/bundler
    //    internals (which drift across versions). When the prop is omitted,
    //    the adapter's detected `manifest.basePath` (if any) stands.
    if (props.basePath !== undefined) {
      const normalized = normalizeBasePath(props.basePath);
      if (normalized) {
        manifest.basePath = normalized;
      } else {
        // Explicit '/' (or empty) means "no base path" — clear any value
        // the adapter may have detected so the prop genuinely wins.
        delete manifest.basePath;
      }
    }

    // ── 4c. Prevent duplicate error pages ────────────────────────
    //    The adapter may auto-detect error pages (e.g. SPA adapter finds
    //    404.html in build output and sets manifest.errorPages). When the
    //    user also provides errorPages via props, the CDN construct would
    //    create DUPLICATE CloudFront custom error responses — one from the
    //    manifest and one from the props.customErrorPages.
    //
    //    Fix: when manifest.errorPages already covers the error codes,
    //    don't pass props.errorPages to the construct. The manifest's
    //    errorPages will drive the CloudFront configuration correctly,
    //    and the HTML files are already in the static assets directory
    //    (copied by the adapter).
    const manifestHasErrorPages = manifest.errorPages !== undefined &&
      Object.keys(manifest.errorPages).length > 0;
    const skipPropsErrorPages = !!(props.errorPages && manifestHasErrorPages);

    // ── 5. Write placeholder config.json into static assets ─────────
    //    A placeholder is needed so the L3 construct sees
    //    .blocks-sandbox/ in the static directory during bundling.
    //    The real config with resolved CDK tokens is deployed in
    //    step 8 via BucketDeployment + Source.jsonData().
    const staticDir = manifest.staticAssets.directory;
    const blocksSandboxDir = join(staticDir, '.blocks-sandbox');
    mkdirSync(blocksSandboxDir, { recursive: true });
    writeFileSync(
      join(blocksSandboxDir, 'config.json'),
      JSON.stringify({ _placeholder: true }),
    );

    // ── 5a. Mark config.json as a no-cache path ─────────────────────
    //    config.json is a fixed-name, mutable runtime-config file: it must
    //    NOT inherit the content-hashed mutable-asset cache-control
    //    (`s-maxage=31536000`) applied to `/assets/<hash>.js`. Registering it
    //    as a no-cache path uploads the build-time placeholder with
    //    `no-cache, no-store, must-revalidate` so an edge never caches it
    //    long-term; the real config is deployed in step 8 with `max-age=60`.
    const configNoCachePath = `${BLOCKS_SANDBOX_DIR}/config.json`;
    const existingNoCachePaths = manifest.staticAssets.noCachePaths ?? [];
    manifest.staticAssets.noCachePaths = existingNoCachePaths.includes(configNoCachePath)
      ? existingNoCachePaths
      : [...existingNoCachePaths, configNoCachePath];

    // ── 5b. Inject static route for .blocks-sandbox config ──────────
    //    Insert a static route for /.blocks-sandbox/* so CloudFront
    //    serves config.json from S3 instead of routing to compute.
    const blocksConfigRoute: RouteBehavior = {
      pattern: '/.blocks-sandbox/*',
      target: 'static',
    };
    // Insert before any catch-all route
    const catchAllIdx = manifest.routes.findIndex((r) => r.pattern === '/*' || r.pattern === '/(.*)')
    if (catchAllIdx >= 0) {
      manifest.routes.splice(catchAllIdx, 0, blocksConfigRoute);
    } else {
      manifest.routes.push(blocksConfigRoute);
    }

    // ── 6. Create the L3 hosting construct ─────────────────────────
    // Validate and normalize compute.timeout: accept both number (seconds) and Duration
    if (props.compute && typeof props.compute.timeout === 'number') {
      if (!Number.isFinite(props.compute.timeout) || props.compute.timeout < 1 || props.compute.timeout > 900) {
        throw new Error(`compute.timeout must be between 1-900 seconds, got: ${props.compute.timeout}`);
      }
    }

    const normalizedCompute = props.compute
      ? {
          ...props.compute,
          timeout: typeof props.compute.timeout === 'number'
            ? cdk.Duration.seconds(props.compute.timeout)
            : props.compute.timeout,
        }
      : undefined;

    const hostingProps: HostingConstructProps = {
      manifest,
      compute: normalizedCompute,
      domain: props.domain,
      waf: props.waf,
      storage: props.retainOnDelete != null
        ? { retainOnDelete: props.retainOnDelete }
        : undefined,
      cdn: (props.contentSecurityPolicy || props.priceClass || props.geoRestriction || props.quotas)
        ? {
            contentSecurityPolicy: props.contentSecurityPolicy,
            priceClass: props.priceClass,
            geoRestriction: props.geoRestriction,
            quotas: props.quotas,
          }
        : undefined,
      logging: props.logging,
      buildCache: props.buildCache,
      errorPages: skipPropsErrorPages ? undefined : props.errorPages,
      monitoring: props.monitoring,
      skewProtection: props.skewProtection,
    };

    const hosting = new HostingConstruct(this, 'Hosting', hostingProps);

    // ── 7. Add CloudFront behaviors for API proxy ────────────────
    if (props.api) {
      this.addApiBehaviors(hosting, props.api.apiUrl);
    }

    // ── 7a. Inject Blocks env vars into compute functions ───────────
    // Lambda@Edge functions (edge-runtime routes) do NOT support environment
    // variables — they surface in computeFunctions as EdgeFunction/IVersion
    // without an `addEnvironment` method. Skip any function that can't take
    // env vars instead of crashing (`fn.addEnvironment is not a function`).
    const canAddEnv = (
      fn: unknown,
    ): fn is cdk.aws_lambda.Function =>
      typeof (fn as { addEnvironment?: unknown })?.addEnvironment === 'function';

    const primaryFunction = [...hosting.computeFunctions.values()].find(
      canAddEnv,
    );

    for (const [, fn] of hosting.computeFunctions) {
      if (!canAddEnv(fn)) continue; // Lambda@Edge: no env var support
      if (props.api) {
        fn.addEnvironment('BLOCKS_API_URL', props.api.apiUrl);
      }
      if (props.backendConfig) {
        fn.addEnvironment('BLOCKS_CONFIG', JSON.stringify(props.backendConfig));
      }
    }

    // ── 8. Deploy config.json with resolved CDK tokens ───────────
    const buildId = manifest.buildId;
    if (buildId) {
      const configDeployment = new s3deploy.BucketDeployment(this, 'BlocksConfigDeployment', {
        sources: [
          s3deploy.Source.jsonData('config.json', this.buildConfigJson(props)),
        ],
        destinationBucket: hosting.bucket,
        destinationKeyPrefix: `builds/${buildId}/.blocks-sandbox`,
        prune: false,
        distribution: hosting.distribution,
        // The skew-protection viewer-request CloudFront function rewrites the
        // URI to `/builds/<buildId>/.blocks-sandbox/config.json` BEFORE the
        // cache lookup, so the real edge cache key lives under `/builds/<id>/`.
        // Invalidating only `/.blocks-sandbox/*` never matches that key and is
        // a no-op for config.json. Invalidate the post-rewrite key too. (The
        // primary guard against staleness is step 5a's no-cache placeholder;
        // this is defense-in-depth so a post-deploy invalidation actually
        // clears any edge entry at its real key.)
        distributionPaths: [
          `/builds/${buildId}/.blocks-sandbox/*`,
          '/.blocks-sandbox/*',
        ],
        cacheControl: [s3deploy.CacheControl.fromString('public, max-age=60, must-revalidate')],
      });

      // Ensure the config deployment runs AFTER the hosting construct's
      // asset deployments. Those deployments upload the whole static dir —
      // which includes the *placeholder* `.blocks-sandbox/config.json`
      // (`{_placeholder:true}`) written during synth — to the same
      // `builds/<id>/.blocks-sandbox/config.json` key this deployment writes
      // the resolved config to. Without an ordering dependency the
      // placeholder can land last and clobber the real config.
      //
      // We depend on EVERY BucketDeployment under the hosting construct
      // rather than a single hard-coded child id: the real children are
      // `AssetDeploymentImmutable` / `AssetDeploymentHtml` / `...Mutable`
      // (and vary by deploy shape), so the previous
      // `tryFindChild('AssetDeployment')` never matched and the dependency
      // was silently never wired.
      const assetDeployments = hosting.node
        .findAll()
        .filter((c): c is s3deploy.BucketDeployment => c instanceof s3deploy.BucketDeployment);
      for (const dep of assetDeployments) {
        configDeployment.node.addDependency(dep);
      }
    }

    // ── 9. Register public origin + CORS hosting origin into S3 config ──
    //    The Handler no longer depends on the BucketDeployment, so including
    //    the CloudFront domain token via registerConfig() is safe — no cycle.
    //    Traffic only flows after the stack is COMPLETE, so the Lambda always
    //    sees the full config (including these values) on its first cold start.
    //
    //    Both values come from `hosting.distributionUrl` (custom-domain-aware:
    //    `https://<customDomain>` when configured, else the CloudFront default)
    //    so a custom-domain deploy gets the right public origin and CORS allow.
    if (props.api) {
      // BLOCKS_PUBLIC_ORIGIN: trusted public origin the app is served from. The
      // auth BB (bb-auth-oidc) reads `process.env.BLOCKS_PUBLIC_ORIGIN` to build
      // OIDC redirect_uris (config-derived, not from a forgeable request
      // header) so server-initiated sign-in lands back on the CloudFront/custom
      // domain — where the session cookie is scoped — instead of the raw
      // execute-api host (which strips the viewer Host header). Kept a literal
      // key (like CORS_HOSTING_ORIGINS below) rather than a shared constant.
      registerConfig(this, 'BLOCKS_PUBLIC_ORIGIN', hosting.distributionUrl);
      registerConfig(this, 'CORS_HOSTING_ORIGINS', hosting.distributionUrl);
    }

    // ── 10. Expose resources ──────────────────────────────────────
    this.bucket = hosting.bucket;
    this.distribution = hosting.distribution;
    this.url = hosting.distributionUrl;
    this.ssrFunction = primaryFunction;
    this.buildCacheBucket = hosting.buildCacheBucket;
    this.monitoringTopic = hosting.monitoringTopic;

    // ── 11. CfnOutput ────────────────────────────────────────────
    new cdk.CfnOutput(this, 'HostingUrl', {
      value: hosting.distributionUrl,
      description: 'Blocks Hosting URL',
    });

    if (hosting.buildCacheBucket) {
      new cdk.CfnOutput(this, 'BuildCacheBucketName', {
        value: hosting.buildCacheBucket.bucketName,
        description: 'S3 bucket for framework build caches',
      });
    }
  }

  /**
   * Build the config.json payload from props.
   *
   * When `api` is provided, the config uses a relative `/aws-blocks/api` URL
   * so the frontend fetches through the same CloudFront domain (no CORS).
   */
  private buildConfigJson(props: HostingProps): Record<string, unknown> {
    return {
      ...(props.backendConfig ?? {}),
      ...(props.api ? { apiUrl: BLOCKS_RPC_PREFIX } : {}),
    };
  }

  /**
   * Add CloudFront behaviors that proxy API traffic to the API Gateway origin.
   */
  private addApiBehaviors(hosting: HostingConstruct, apiUrl: string): void {
    const baseUrl = cdk.Fn.select(0, cdk.Fn.split(BLOCKS_RPC_PREFIX, apiUrl));
    const withoutScheme = cdk.Fn.select(1, cdk.Fn.split('https://', baseUrl));
    const hostname = cdk.Fn.select(0, cdk.Fn.split('/', withoutScheme));
    const stage = cdk.Fn.select(1, cdk.Fn.split('/', withoutScheme));

    const apiGatewayOrigin = new HttpOrigin(hostname, {
      originPath: `/${stage}`,
    });

    const behaviorDefaults = {
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy: CachePolicy.CACHING_DISABLED,
      originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    };

    hosting.distribution.addBehavior(BLOCKS_RPC_PREFIX, apiGatewayOrigin, behaviorDefaults);
    hosting.distribution.addBehavior(`${BLOCKS_RPC_PREFIX}/*`, apiGatewayOrigin, behaviorDefaults);

    // Proxy the auth BB's reserved subtree as a single behavior. The auth flow
    // (callback, sign-in, exchange, authorize-params, the stub IdP) is mounted
    // only at runtime; declaring the subtree wildcard here — rather than per
    // route at synth — proxies the whole flow regardless of providers or
    // instance count, and never drifts as routes are added. Added directly (not
    // via the route loop below) so it's emitted exactly once even with multiple
    // AuthOIDC instances.
    hosting.distribution.addBehavior(`${BLOCKS_AUTH_PREFIX}/*`, apiGatewayOrigin, behaviorDefaults);

    const addedPatterns = new Set<string>([`${BLOCKS_RPC_PREFIX}/*`, `${BLOCKS_AUTH_PREFIX}/*`]);
    for (const route of getRegisteredRoutes()) {
      if (route.path.startsWith(`${BLOCKS_RPC_PREFIX}/`)) continue;
      if (route.path === BLOCKS_AUTH_PREFIX || route.path.startsWith(`${BLOCKS_AUTH_PREFIX}/`)) continue;

      let behaviorPattern: string;
      const paramIndex = route.path.indexOf('/{');
      if (paramIndex !== -1) {
        behaviorPattern = route.path.substring(0, paramIndex) + '/*';
      } else {
        behaviorPattern = route.path;
      }

      if (addedPatterns.has(behaviorPattern)) continue;

      if (behaviorPattern.endsWith('/*')) {
        console.warn(
          `[Hosting] ⚠️  RawRoute '${route.path}' creates CloudFront behavior '${behaviorPattern}' ` +
          `which may shadow SSR/frontend routes under the same prefix. ` +
          `Consider placing this route under ${BLOCKS_RPC_PREFIX}/ to avoid conflicts.`,
        );
      }

      addedPatterns.add(behaviorPattern);
      hosting.distribution.addBehavior(behaviorPattern, apiGatewayOrigin, behaviorDefaults);
    }
  }
}
