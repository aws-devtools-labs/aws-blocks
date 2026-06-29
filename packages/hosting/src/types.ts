import { Duration } from 'aws-cdk-lib';
import {
  Distribution,
  IResponseHeadersPolicy,
  PriceClass,
} from 'aws-cdk-lib/aws-cloudfront';
import { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { IKey } from 'aws-cdk-lib/aws-kms';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Bucket, IBucket } from 'aws-cdk-lib/aws-s3';
import { FrameworkAdapterFn } from './adapters/index.js';

/**
 * Open union type for framework names.
 * Provides autocomplete for built-in frameworks while accepting any string.
 */
export type FrameworkType =
  | 'nextjs'
  | 'nitro'
  | 'nuxt'
  | 'astro'
  | 'spa'
  | 'static'
  | (string & {});

/**
 * Configuration for defineHosting.
 */
export type HostingProps = {
  /**
   * Optional build command (e.g., 'npm run build').
   * Used by adapters to build the project before deploying.
   */
  buildCommand?: string;

  /**
   * Framework type — auto-detected from package.json or set explicitly.
   * Accepts built-in values ('nextjs', 'spa', 'static') or any custom string.
   */
  framework?: FrameworkType;

  /**
   * Explicit path (relative to project root) where pre-built output lives.
   * When set, the SPA/static adapter uses this directory directly instead of
   * auto-detecting (dist/, build/, out/).
   * For Next.js, this is not used — OpenNext always runs its own build.
   */
  buildOutputDir?: string;

  /**
   * Custom framework adapter for unsupported frameworks.
   * When provided, this adapter is used instead of the built-in registry lookup.
   * Receives the project directory and returns a DeployManifest.
   */
  customAdapter?: FrameworkAdapterFn;

  /**
   * Custom domain configuration.
   *
   * When `hostedZone` (or `hostedZoneId`) is provided, Route 53 A/AAAA records
   * are created automatically. When omitted (BYO domain), the user manages DNS
   * externally - the distribution domain name is output for CNAME configuration.
   * @example
   * ```typescript
   * // Single domain
   * domain: { domainName: 'example.com', hostedZone: 'example.com' }
   *
   * // Multiple domains with www redirect
   * domain: {
   *   domainName: ['example.com', 'www.example.com'],
   *   hostedZone: 'example.com',
   *   wwwRedirect: 'toApex',
   * }
   *
   * // BYO domain - user manages DNS externally
   * domain: {
   *   domainName: ['example.com'],
   *   certificate: myCert,
   * }
   * ```
   */
  domain?: {
    /** Domain name(s) for the hosting distribution. Accepts a single domain or an array for multi-domain setups. */
    domainName: string | string[];
    /**
     * Route 53 hosted zone domain name (e.g. 'example.com').
     * When omitted, DNS records are not created — the user must configure
     * their external DNS to CNAME to the CloudFront distribution domain.
     */
    hostedZone?: string;
    /**
     * Route 53 hosted zone ID. When provided, avoids `HostedZone.fromLookup()`
     * (which requires `env: { account, region }` on the stack). Useful in
     * pipeline stages where account/region aren't known at synth time.
     */
    hostedZoneId?: string;
    /** BYO ACM certificate (must be in us-east-1 for CloudFront). */
    certificate?: ICertificate;
    /**
     * Redirect www to apex (or vice versa) via a CloudFront Function.
     * Only effective when both apex and www are included in domain names.
     * @default 'none'
     */
    wwwRedirect?: 'toApex' | 'toWww' | 'none';
  };

  /**
   * WAF configuration.
   */
  waf?: {
    enabled: boolean;
    /** Requests per 5-minute window per IP. Default: 1000 */
    rateLimit?: number;
    /**
     * ARN of an existing WAFv2 WebACL in us-east-1. When provided, the
     * construct uses this ACL directly instead of creating a new one.
     * Enables cross-region deployments (WebACL in us-east-1, stack elsewhere).
     */
    webAclArn?: string;
  };

  /**
   * Enable build caching. Preserves framework build cache (e.g. `.next/cache`)
   * between deploys via S3.
   *
   * When enabled, an S3 bucket is provisioned (or a user-provided bucket is used)
   * and the bucket name is exported as a CfnOutput and set as the
   * `HOSTING_BUILD_CACHE_BUCKET` environment variable on compute functions.
   * Users sync the cache in their CI pipeline.
   * @example
   * ```typescript
   * defineHosting({
   *   buildCache: { enabled: true },
   * });
   * ```
   */
  buildCache?: {
    enabled: boolean;
    /** S3 bucket to store build cache. If not provided, creates one. */
    bucket?: IBucket;
  };

  /**
   * Compute (Lambda) configuration for SSR frameworks.
   * Ignored for SPA and static site deployments.
   */
  compute?: {
    /** Lambda memory size in MB. Default: 1024 */
    memorySize?: number;
    /**
     * Lambda timeout — a `Duration` or a plain number of seconds. Default:
     * 30 seconds. The number form exists for ergonomic JS callers; the L3
     * coerces both via `normalizeTimeout`.
     */
    timeout?: Duration | number;
    /** Reserved concurrent executions. Default: undefined (no reservation). */
    reservedConcurrency?: number;
    /**
     * Image-optimization Lambda overrides. `reservedConcurrency` defaults to
     * undefined (no reservation) — see the note in the L3 construct on why
     * the old hardcoded value of 10 broke deploys on fresh AWS accounts.
     */
    imageOptimization?: {
      /** Reserved concurrent executions. Default: undefined (no reservation). */
      reservedConcurrency?: number;
    };
    /** Provisioned concurrency for cold-start elimination. Default: undefined (no provisioning). */
    provisionedConcurrency?: number;
    /** CloudWatch log retention for the SSR Lambda. Default: ONE_MONTH. */
    logRetention?: RetentionDays;
    /**
     * 2.1 — synthetic warmup. When set, an EventBridge schedule
     * invokes the SSR Lambda every `rate` to keep at least one
     * execution environment hot, eliminating cold starts on
     * intermittent traffic. Skipped automatically when
     * `provisionedConcurrency` is set (already warm).
     *
     * Cost: ~$0.01/month per minute of rate (Lambda invoke +
     * EventBridge rule).
     */
    warmup?: {
      rate: Duration;
    };
    /**
     * 4.1 — OpenTelemetry environment hooks. Injected onto every
     * Lambda the construct creates (SSR, image-opt, revalidation,
     * middleware, warmup).
     *
     * **Bring your own instrumentation.** This option ONLY sets the
     * `OTEL_*` env vars — it does NOT install any OpenTelemetry SDK or
     * collector. Env vars alone are inert: setting `otelEndpoint`
     * without also adding instrumentation produces **no traces**. To
     * actually emit spans you must additionally do ONE of:
     *   - attach the AWS Distro for OpenTelemetry (ADOT) Lambda layer
     *     to your functions, or
     *   - bundle an OTel SDK and auto-instrument via
     *     `NODE_OPTIONS=--require @opentelemetry/auto-instrumentations-node/register`.
     *
     * The construct stays SDK-agnostic on purpose so it doesn't pin an
     * OTel version or pull a large layer into every deploy.
     */
    tracing?: {
      /** OTEL_EXPORTER_OTLP_ENDPOINT — collector base URL. */
      otelEndpoint: string;
      /**
       * OTEL_EXPORTER_OTLP_HEADERS — comma-separated `key=value`
       * pairs (auth tokens, vendor headers).
       */
      otelHeaders?: string;
      /** OTEL_SERVICE_NAME — the service name reported to the OTEL collector. */
      serviceName?: string;
    };
  };

  /**
   * Custom environment variables injected into all compute Lambda functions at runtime.
   *
   * Values appear in plaintext in the CloudFormation template. For sensitive values
   * (database passwords, API secrets), use AWS Systems Manager Parameter Store or
   * Secrets Manager and read them at runtime instead.
   *
   * Safe for: feature flags, non-secret URLs, region config, service names.
   * @example
   * ```typescript
   * defineHosting({
   *   environment: {
   *     DATABASE_URL: process.env.DATABASE_URL,
   *     FEATURE_FLAGS_API_KEY: process.env.FF_KEY,
   *   },
   * });
   * ```
   */
  environment?: Record<string, string>;

  /**
   * Custom error page configuration.
   * Provide paths to HTML files for custom 404 and 500 error responses.
   * @example
   * ```typescript
   * defineHosting({
   *   errorPages: {
   *     notFound: './public/404.html',
   *     serverError: './public/500.html',
   *   },
   * });
   * ```
   */
  errorPages?: {
    /** Path to a custom 404 HTML file (relative to project root). */
    notFound?: string;
    /** Path to a custom 500 HTML file (relative to project root). */
    serverError?: string;
  };

  /**
   * CDN (CloudFront) configuration.
   */
  cdn?: {
    /** CloudFront price class. Default: PRICE_CLASS_100 (US, Canada, Europe). */
    priceClass?: PriceClass;
    /** Custom Content-Security-Policy header value. If not set, a restrictive default is used. */
    contentSecurityPolicy?: string;
    /** Geo-restriction configuration for CloudFront distribution. */
    geoRestriction?: {
      type: 'whitelist' | 'blacklist';
      countries: string[];
    };
    /**
     * Default TTL for SSR/compute cache behaviors when the origin response
     * has no `Cache-Control` header. Set this to enable edge caching of SSR
     * responses; the origin can still override via `s-maxage`/`no-store`.
     * @default Duration.seconds(0) — no caching unless the origin opts in.
     */
    ssrDefaultTtl?: Duration;
    /**
     * Bring-your-own ResponseHeadersPolicy. When provided, the construct
     * skips creating its own — share one policy across stacks to avoid the
     * account-level policy limit (default 20, max 200 via quota increase).
     */
    responseHeadersPolicy?: IResponseHeadersPolicy;
    /**
     * ARN of an existing WAFv2 WebACL to associate with the distribution.
     * Use when you manage WAF externally or need rules beyond the built-in
     * `waf.enabled` rate-limiting. Takes precedence over `waf.enabled`.
     */
    webAclArn?: string;
  };

  /**
   * S3 storage configuration.
   */
  storage?: {
    /** Encryption type for the hosting bucket. Default: S3_MANAGED. */
    encryption?: 'S3_MANAGED' | 'KMS';
    /** BYO KMS key for bucket encryption (requires encryption: 'KMS'). */
    encryptionKey?: IKey;
    /** If true, the S3 bucket is retained on stack deletion. Default: false. */
    retainOnDelete?: boolean;
    /** Days to retain build artifacts in S3. Default: 30. */
    buildRetentionDays?: number;
    /**
     * Opt-in S3 inventory of `builds/` (3.3). When enabled, a daily
     * CSV report of every object under `builds/` lands in a
     * dedicated inventory bucket. Useful for cost audits — find
     * which build is the heavy one without `aws s3 ls --summarize`
     * per prefix. Off by default.
     */
    inventory?: {
      enabled: boolean;
    };
  };

  /**
   * CloudFront access logging configuration.
   */
  logging?: {
    /** Enable CloudFront access logging to a dedicated S3 bucket. */
    enabled: boolean;
    /** Days to retain access logs. Default: 90. */
    retentionDays?: number;
  };

  /**
   * CloudWatch alarm wiring. **Enabled by default** so users get
   * out-of-the-box visibility into CloudFront 5xx rate, SSR Lambda
   * errors/throttles, image-opt errors, and revalidation DLQ depth.
   * Idle cost is a few cents per month per alarm — set
   * `monitoring: { enabled: false }` to opt out.
   *
   * If `snsTopicArn` is omitted, an SNS topic is created and surfaced
   * via the construct's `monitoringTopic` field for the caller to
   * subscribe to.
   */
  monitoring?: {
    /** @default true */
    enabled?: boolean;
    /**
     * BYO SNS topic ARN for alarm actions. When omitted, an SNS topic
     * is created.
     */
    snsTopicArn?: string;
  };

  /**
   * Cookie-based skew protection. When enabled, viewers mid-session keep
   * receiving assets from their original build, preventing asset mismatches
   * during rolling deploys.
   *
   * **Enabled by default.** Set `{ enabled: false }` to disable (e.g. when
   * debugging a pinned-to-broken-build situation). Tune `maxAge` to align
   * the cookie lifetime with `storage.buildRetentionDays` — a `maxAge`
   * longer than the build retention can pin a returning viewer to a
   * lifecycle-deleted build prefix (→ 403).
   * @default \{ enabled: true \}
   */
  skewProtection?: {
    enabled: boolean;
    /** How long to honor old build cookies (seconds). Default: 86400 (24h). */
    maxAge?: number;
  };
};

/**
 * CDK resources created by the hosting construct.
 */
export type HostingResources = {
  /**
   * The S3 bucket storing hosting assets.
   */
  bucket: Bucket;

  /**
   * The CloudFront distribution serving the site.
   */
  distribution: Distribution;

  /**
   * The URL of the deployed site.
   */
  distributionUrl: string;

  /**
   * The S3 bucket used for build caching (when `buildCache.enabled` is true).
   */
  buildCacheBucket?: Bucket;
};
