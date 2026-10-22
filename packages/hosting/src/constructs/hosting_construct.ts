import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Annotations,
  CfnOutput,
  CfnResource,
  CustomResource,
  Duration,
  Fn,
  RemovalPolicy,
  Size,
  Stack,
  Stage,
  Token,
} from 'aws-cdk-lib';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  type Distribution,
  experimental,
  type IResponseHeadersPolicy,
  type PriceClass,
  ResponseHeadersPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, RuleTargetInput, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaFunctionTarget } from 'aws-cdk-lib/aws-events-targets';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import { type Alias, Code, type FunctionUrl, type IVersion, Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { IHostedZone } from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, CacheControl, Source } from 'aws-cdk-lib/aws-s3-deployment';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import type {
  EmailSubscription,
  UrlSubscription,
} from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Alarm } from 'aws-cdk-lib/aws-cloudwatch';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import type { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct, type IConstruct, type IDependable } from 'constructs';
import { ERROR_PAGE_KEY, generateBuildId, NOT_FOUND_PAGE_KEY } from '../defaults.js';
import { HostingError } from '../hosting_error.js';
import type { DeployManifest } from '../manifest/types.js';
import {
  type EnvValue,
  type KindStoreOptions,
  partitionEnvironment,
  type StoreConfig,
  wireByo,
  wireManagedValue,
} from '../secret-resolve.js';
import type { HostingResources } from '../types.js';
import type { CdnConstruct, CdnConstructProps } from './cdn_construct.js';
import { buildHostingPlan } from '../plan/hosting-plan.js';
import { routeSpecificity } from '../plan/route-table.js';
import { prependBasePath } from '../adapters/shared/basepath.js';
import { albDoor } from './alb_door.js';
import { AlbConstruct } from './alb_construct.js';
import {
  ALB_EVENT_SHIM_FILE,
  ALB_EVENT_SHIM_HANDLER,
  FORWARDED_HOST_SHIM_FILE,
  FORWARDED_HOST_SHIM_HANDLER,
  generateAlbEventShimCode,
  generateForwardedHostShimCode,
} from './alb_lambda_event.js';
import { apiGatewayDoor } from './apigw_door.js';
import { registerUploads } from './cf_helpers.js';
import { ALB_LAMBDA_RESPONSE_LIMIT, LAMBDA_SYNC_RESPONSE_LIMIT, warnOversizedProxyAssets } from './proxy_limits.js';
import { cloudFrontDoor } from './cloudfront_door.js';
import { buildFrontDoor } from './custom_door.js';
import { buildDoorInput } from './door_input.js';
import { DEFAULT_NOT_FOUND_PAGE_HTML, needsDefaultNotFoundPage } from './default_not_found.js';
import type { DoorInput, FrontDoorResult } from './front_door.js';
import {
  type FrontDoorKind,
  type HostingFrontDoor,
  type ResolvedFrontDoor,
  resolveFrontDoorFeatures,
  type StackedRouterDoorOptions,
} from './front_door_options.js';
import type { OriginHandle } from './layer.js';
import { s3WebsiteDoor } from './s3_website_door.js';
import type { AccessLogFormat, AccessLogPartitioning } from './access_logging.js';
import { ComputeConstruct } from './compute_construct.js';
import { DnsConstruct } from './dns_construct.js';
import { MonitoringConstruct } from './monitoring_construct.js';
import { UsEast1MonitoringStack } from './us_east_1_monitoring_stack.js';
import { DEFAULT_NODE_RUNTIME } from './node_runtime.js';
import type { QuotaOverrides } from './quota_budget.js';
import { createManagedEquivalentSecurityHeadersPolicy, createSecurityHeadersPolicy } from './security_headers.js';
import { StorageConstruct, DEFAULT_BUILD_RETENTION_DAYS } from './storage_construct.js';
import { WafConstruct } from './waf_construct.js';
import { WEB_FUNCTION_INTERNAL_HEADERS, WebFunctionConstruct, type WebFunctionOptions } from './web_function_construct.js';

// Re-export build ID helpers for public API + tests
export { generateBuildId, generateBuildIdFunctionCode } from '../defaults.js';
export type { SkewProtectionConfig } from './skew_protection.js';

// CloudFormation hard limit: 500 resources per stack (not adjustable). We warn
// well before it so the operator can split the stack before a deploy fails.
const CFN_MAX_RESOURCES_PER_STACK = 500;
const CFN_RESOURCE_WARNING_THRESHOLD = 450;

// ---- Public types ----

/**
 * Domain configuration for custom domain support.
 * Supports multiple domains and optional www redirect.
 */
export type HostingDomainConfig = {
  /** Domain name(s) for the hosting distribution. Accepts a single domain or an array for multi-domain setups. */
  domainName: string | string[];
  /**
   * Route 53 hosted zone domain name. When omitted (along with hostedZoneId),
   * DNS records are not created — user manages DNS externally.
   */
  hostedZone?: string;
  /**
   * Route 53 hosted zone ID. Avoids HostedZone.fromLookup() which requires
   * env: { account, region } on the stack. Useful in pipeline stages.
   */
  hostedZoneId?: string;
  /** BYO certificate — avoids deprecated DnsValidatedCertificate when provided. */
  certificate?: ICertificate;
  /**
   * Redirect www to apex (or vice versa) via a CloudFront Function.
   * @default 'none'
   */
  wwwRedirect?: 'toApex' | 'toWww' | 'none';
};

/**
 * WAF configuration for CloudFront protection.
 */
export type HostingWafConfig = {
  enabled: boolean;
  /** Requests per 5-minute window per IP. Default: 1000 */
  rateLimit?: number;
  /**
   * ARN of an existing WAFv2 WebACL in us-east-1. When provided, the
   * construct uses this ACL directly instead of creating a new one.
   * Enables cross-region deployments.
   */
  webAclArn?: string;
};

/**
 * Props for the HostingConstruct.
 *
 * This construct is FRAMEWORK-AGNOSTIC. It reads a DeployManifest and
 * provisions infrastructure accordingly. It never imports Next.js or OpenNext.
 */
export type HostingConstructProps = {
  /** Deploy manifest produced by the framework adapter. */
  manifest: DeployManifest;
  /**
   * Skips region validation for WAF WebACL (must be us-east-1 for CloudFront),
   * ACM certificates (must be us-east-1 for CloudFront), and Lambda Web Adapter
   * compatibility checks. Useful for testing.
   *
   * Also skips the CloudFront standard logging v2 delivery-source Region check
   * (`logging.version: 'v2'` must deploy to us-east-1), so a v2 stack outside
   * us-east-1 synthesizes cleanly and then fails at deploy.
   */
  skipRegionValidation?: boolean;

  /**
   * Custom domain configuration.
   * @deprecated Use `frontDoor.features.domain` (CloudFront, API Gateway, custom doors).
   */
  domain?: HostingDomainConfig;
  /**
   * WAF configuration.
   * @deprecated Use `frontDoor.features.waf` (CloudFront, ALB, custom doors).
   */
  waf?: HostingWafConfig;
  /** Compute (Lambda) overrides for all compute resources. */
  compute?: {
    /**
     * Where the SSR server runs: `'lambda'` (default — Lambda behind API
     * Gateway) or `'web-function'` (AWS Lambda Web Functions behind CloudFront
     * OAC; HTTP-server builds only, supported Regions only).
     * @see HostingProps.compute.type for the full note.
     */
    type?: 'lambda' | 'web-function';
    /** Lambda Web Functions tuning. Only used when `type` is `'web-function'`. */
    webFunction?: WebFunctionOptions;
    memorySize?: number;
    /**
     * Lambda timeout. Accepts either a `cdk.Duration` (preferred) or a
     * number of seconds for ergonomics — the L3 normalizes both to
     * `Duration` before handing them to the Lambda construct. A plain
     * number used to slip through the type at the user-facing API
     * surface (e.g. when consumed via JS-compiled wrappers) and crash
     * synth deep inside aws-cdk-lib with `props.timeout.toSeconds is
     * not a function`. Coercing here makes that surface forgiving.
     */
    timeout?: Duration | number;
    reservedConcurrency?: number;
    /**
     * Reserved concurrent executions for the image-optimization Lambda.
     * Default: undefined (no reservation).
     *
     * Historically this was hardcoded to 10, which broke `cdk deploy` on
     * fresh AWS accounts: the default account-level unreserved-concurrency
     * limit is 10, so reserving all 10 for image-opt drops the account
     * below its required minimum and Lambda rejects the stack with a 400.
     * Defaulting to no reservation keeps deploys working out of the box
     * while still letting operators cap image-opt explicitly.
     */
    imageOptimization?: {
      reservedConcurrency?: number;
    };
    /**
     * Provisioned concurrency for the SSR Lambda (cold-start elimination).
     * When > 0, the construct creates a `live` alias with this many
     * always-warm execution environments and points the SSR REST API
     * integration at the alias. Default: undefined (no provisioning).
     */
    provisionedConcurrency?: number;
    logRetention?: RetentionDays;
    /**
     * Additional environment variables to inject into all compute Lambda
     * functions. Merged with (and overrides) any environment variables
     * declared in the deploy manifest's compute resources.
     */
    environment?: Record<string, string>;
    /** 2.1 — synthetic warmup schedule. */
    warmup?: { rate: Duration };
    /** 4.1 — OpenTelemetry env hooks for SSR / image-opt / revalidation Lambdas. */
    tracing?: {
      otelEndpoint: string;
      otelHeaders?: string;
      serviceName?: string;
    };
  };
  /**
   * CDN (CloudFront) configuration.
   * @deprecated Use `frontDoor.features` — each `cdn.<x>` is `frontDoor.features.<x>`
   * (`cdn.webAclArn` is `frontDoor.features.waf.webAclArn`).
   */
  cdn?: {
    /** @deprecated Use `frontDoor.features.priceClass`. */
    priceClass?: PriceClass;
    /** @deprecated Use `frontDoor.features.contentSecurityPolicy`. */
    contentSecurityPolicy?: string;
    /** @deprecated Use `frontDoor.features.geoRestriction` (CloudFront, custom doors). */
    geoRestriction?: {
      type: 'whitelist' | 'blacklist';
      countries: string[];
    };
    /**
     * Default TTL for SSR/compute cache behaviors when the origin sends no
     * `Cache-Control` header. Enables CloudFront edge caching of SSR
     * responses; the origin can override via `s-maxage`/`no-store`. Synth
     * fails closed if this resolves to `> 0` and neither {@link cacheKeyCookies}
     * nor {@link cacheKeyHeaders} is set.
     *
     * @see HostingProps.cdn.ssrDefaultTtl for the full note on cache-key
     * credentials and the fail-closed guard.
     * @default Duration.seconds(0) — no caching unless origin opts in
     * @deprecated Use `frontDoor.features.ssrDefaultTtl`.
     */
    ssrDefaultTtl?: Duration;
    /**
     * Cookie names to include in the SSR cache key. Set your session cookie
     * name(s) here so authenticated SSR responses are cached per-session
     * rather than shared across users. Required (together with or instead of
     * `cacheKeyHeaders`) to safely enable `ssrDefaultTtl`.
     * CloudFront allows at most 10 cookies in the cache key (2 are reserved
     * for Next.js preview mode).
     * @deprecated Use `frontDoor.features.cacheKeyCookies`.
     */
    cacheKeyCookies?: string[];
    /**
     * Header names to include in the SSR cache key (e.g. `'authorization'`).
     * Use to vary cached SSR responses by credential-bearing headers.
     * `'accept-encoding'` is not allowed (handled automatically). Required
     * (together with or instead of `cacheKeyCookies`) to safely enable
     * `ssrDefaultTtl`.
     * @deprecated Use `frontDoor.features.cacheKeyHeaders`.
     */
    cacheKeyHeaders?: string[];
    /**
     * Bring-your-own ResponseHeadersPolicy. When provided, the construct
     * skips creating its own policy — use this to share a single policy
     * across multiple hosting stacks and avoid the account-level limit
     * (default 20, max 200 via service-quota increase).
     *
     * Create a shared policy once (e.g. in a shared-infra stack):
     * ```ts
     * const sharedPolicy = new ResponseHeadersPolicy(sharedStack, 'SharedPolicy', { ... });
     * ```
     * Then import by ID in each hosting stack:
     * ```ts
     * cdn: { responseHeadersPolicy: ResponseHeadersPolicy.fromResponseHeadersPolicyId(this, 'Imported', policyId) }
     * ```
     * @deprecated Use `frontDoor.features.responseHeadersPolicy`.
     */
    responseHeadersPolicy?: IResponseHeadersPolicy;
    /**
     * ARN of an existing WAFv2 WebACL to associate with the CloudFront
     * distribution. Use this when you manage WAF rules externally (e.g.
     * via a shared security account) or need advanced WAF features beyond
     * the built-in `waf.enabled` rate-limiting.
     *
     * Takes precedence over `waf.enabled` — when set, the built-in WAF
     * construct is not created.
     * @deprecated Use `frontDoor.features.waf.webAclArn`.
     */
    webAclArn?: string;
    /**
     * Overrides for the adjustable AWS Service Quotas this distribution draws
     * on — `cacheBehaviors` (CloudFront behaviors per distribution),
     * `edgeFunctions` (Lambda@Edge associations), and `headerPolicies`
     * (response-headers policies per account). Omitted fields use AWS
     * defaults.
     *
     * Set a field ONLY to match a quota increase AWS has actually granted:
     * synth cannot verify your real quota, so an over-set value does not raise
     * the AWS ceiling — it just moves the failure from a clear synth error to
     * an opaque CloudFormation rollback at deploy.
     * @deprecated Use `frontDoor.features.quotas`.
     */
    quotas?: QuotaOverrides;
  };
  /** S3 storage configuration. */
  storage?: {
    encryption?: 'S3_MANAGED' | 'KMS';
    encryptionKey?: IKey;
    retainOnDelete?: boolean;
    buildRetentionDays?: number;
    /** Advisory hint used at synth to warn when deploy cadence ≥ retention (#480). */
    deployIntervalDays?: number;
    /** 3.3 — opt-in daily S3 inventory of `builds/`. */
    inventory?: { enabled: boolean };
    /**
     * Resources for the Lambda that uploads static assets to S3 (CDK's
     * `BucketDeployment`). CDK defaults this Lambda to 128 MB memory and a
     * 512 MiB `/tmp` — too small for large static sites, which then OOM or
     * run out of disk with an opaque CloudFormation error at deploy time.
     * The L3 raises the defaults to 1024 MB / 1024 MiB; override here if a
     * very large build still hits the ceiling.
     */
    deployment?: {
      /** Memory (MiB) for the asset-upload Lambda. @default 1024 */
      memoryLimit?: number;
      /** `/tmp` size (MiB) for the asset-upload Lambda. @default 1024 */
      ephemeralStorageMiB?: number;
    };
  };
  /**
   * CloudFront access logging configuration.
   * @deprecated Use `frontDoor.features.logging` (CloudFront, ALB, custom doors).
   */
  logging?: {
    enabled: boolean;
    retentionDays?: number;
    /**
     * CloudFront logging pipeline: `'v1'` (default, legacy standard logging) or
     * `'v2'` (standard logging v2 via the CloudWatch Logs delivery pipeline —
     * ACL-free bucket, partitioned S3 layout, selectable format). See the
     * public `HostingProps.logging` docs for trade-offs. @default 'v1'
     */
    version?: 'v1' | 'v2';
    /** (v2 only) S3 key layout for delivered logs. @default 'date' */
    partitioning?: AccessLogPartitioning;
    /** (v2 only) Delivered log record format. @default 'w3c' */
    format?: AccessLogFormat;
  };
  /**
   * Custom environment variables for all compute functions. A value may be:
   * - a plain string (injected verbatim),
   * - a `secret('K')` marker → wired at runtime from **Secrets Manager** (read via `getSecret('K')`),
   * - a `config('K')` marker → wired at runtime from **SSM Parameter Store** (read via `getConfig('K')`),
   * - a BYO `ISecret` / `IParameter` handle → granted + wired identically (read via `getSecret`/`getConfig`).
   *
   * For each managed/BYO value the store LOCATOR (never the value) is injected and
   * the compute role granted read+decrypt. Domain markers resolve at synth and
   * must go through the async wrapper (e.g. `Hosting.create()`).
   */
  environment?: Record<string, EnvValue>;
  /**
   * Namespace/cache config for **secret** values (Secrets Manager). Defaults to
   * the neutral `/hosting/secrets` prefix; a branded consumer overrides it (e.g.
   * Blocks passes `/blocks/secrets`). Governs `prefix`, `stage`, `cacheTtlSeconds`.
   */
  secretStore?: KindStoreOptions;
  /**
   * Namespace/cache config for **config** values (SSM Parameter Store). Defaults
   * to the neutral `/hosting/config` prefix. Governs `prefix`, `stage`, `cacheTtlSeconds`.
   */
  configStore?: KindStoreOptions;
  /**
   * Build cache configuration. When enabled, provisions an S3 bucket for
   * framework build caches and exports the bucket name.
   */
  buildCache?: {
    enabled: boolean;
    /** BYO S3 bucket for build cache storage. Creates one if not provided. */
    bucket?: s3.IBucket;
  };
  /**
   * Custom error page configuration.
   * Provide paths to HTML files for custom 404 and 500 error responses.
   */
  errorPages?: {
    /** Path to a custom 404 HTML file (relative to project root). */
    notFound?: string;
    /** Path to a custom 500 HTML file (relative to project root). */
    serverError?: string;
  };
  /**
   * Default CloudWatch alarms (P3.1 + P3.2). On by default. When
   * enabled, the L3 wires CloudFront 5xx, Lambda error / throttle,
   * and revalidation-DLQ alarms to an SNS topic. Opt out with
   * `{ enabled: false }`. See `MonitoringConstruct`.
   * @deprecated Use `frontDoor.features.monitoring` (CloudFront, ALB, custom doors).
   */
  monitoring?: {
    /** @default true */
    enabled?: boolean;
    /**
     * Endpoint subscriptions applied to both hosting alarm topics (the
     * app-region topic and, off-region, the us-east-1 CloudFront topic).
     * `EmailSubscription` / `UrlSubscription` from
     * `aws-cdk-lib/aws-sns-subscriptions` only — resource-target
     * subscriptions (Lambda/SQS) are not yet supported (they'd create an
     * unresolvable cross-region reference to the us-east-1 topic).
     */
    subscriptions?: Array<EmailSubscription | UrlSubscription>;
  };
  /**
   * Cookie-based skew protection.
   * When enabled, users mid-session keep receiving assets from their original
   * build, preventing asset mismatches during rolling deployments.
   * @default \{ enabled: true \} — skew protection is enabled by default.
   * Set `\{ enabled: false \}` to disable.
   * @deprecated Use `frontDoor.features.skewProtection` (CloudFront, custom doors).
   */
  skewProtection?: {
    enabled: boolean;
    /** How long to honor old build cookies (seconds). Default: 86400 (24h) */
    maxAge?: number;
  };
  /**
   * Which FRONT DOOR serves the deploy. The front door is the public entry
   * point that routes requests to the origins (static/S3, SSR, image-opt) AND
   * to the backend/API surface same-origin.
   *
   * When Hosting is present this IS the app's shared front door: it owns the
   * full front-door surface — routing, caching, security (WAF), private-asset
   * access (S3 OAC / asset-proxy), deployment/atomic-release, custom domains/TLS,
   * and same-origin routing to the backend/API (each namespace → its owning
   * compute; see the plan's `backend`). The multi-compute `apiFrontDoor` concept
   * only stands up its own door when there is NO Hosting to reuse.
   *
   * - `'cloudfront'` (default) — the global CloudFront CDN (today's behavior;
   *   full edge caching, WAF, custom domains, streaming). Unchanged.
   * - `{ kind: 'alb', … }` — an Application Load Balancer (regional, no CDN).
   *   For enterprises behind an existing ALB, private/internal deploys, or
   *   apps that simply don't need a global edge. The ALB has no edge cache,
   *   skew protection or geo restriction; the app's redirects, header rules
   *   and error pages are applied by its asset proxy (and the headers by its
   *   API forwarder), except on responses it routes straight to the server or
   *   image function (synth names them: `DoorRulesNotApplied`). A custom
   *   domain (`features.domain`, with `certificate`) serves HTTPS.
   * - `{ kind: 'apiGateway', … }` — an Amazon API Gateway as the front door
   *   (regional, no CDN, no VPC/NAT, scale-to-zero, pay-per-request). The
   *   *serverless* sibling of the ALB door: API Gateway owns routing (a route
   *   per origin/namespace), serves private S3 assets via an asset-proxy
   *   Lambda, and proxies `/aws-blocks/*` same-origin to the backend natively
   *   (no forwarder Lambda). Best for a SPA/SSR app that wants no CDN and no
   *   always-on ALB baseline. It has no edge cache, skew protection or geo
   *   restriction; redirects, header rules and error pages are applied by the
   *   asset proxy, as on the ALB door. Choose the flavor with `api`:
   *   `'http'` (default; SSR responses are buffered) or `'rest'` (streamed SSR;
   *   requires `domain`).
   *
   * Every door except `'none'` routes `/aws-blocks/*` and the backend's raw
   * routes to the API same-origin. A door that invokes the server without
   * streaming (ALB, the HTTP API, a custom door with `serverResponse:
   * 'buffered'`) gets a server built in buffered mode.
   * - `{ kind: 'custom', door }` — bring your own front door, written as one
   *   `build` function (see {@link FrontDoor} and `defineFrontDoor`).
   *
   * A setting a door kind doesn't implement is a type error in `features`
   * and a synth error through a deprecated top-level prop (see below). A
   * bring-your-own door is checked only for its routing (see `wiringCheck`):
   * which of `input.features` it applies is its author's call.
   *
   * Each door kind takes its settings as `features`, typed for that kind: only
   * the settings that door implements compile (see `CloudFrontDoorFeatures`,
   * `AlbDoorFeatures`, `ApiGatewayDoorFeatures`, `CustomDoorFeatures`).
   * `{ features }` (no `kind`) is the CloudFront default with settings. The
   * top-level `domain`, `waf`, `cdn.*`, `logging`, `monitoring` and
   * `skewProtection` props are deprecated aliases, merged into
   * `frontDoor.features` at construction: setting one both ways fails synth
   * (`FrontDoorSettingConflictError`), and so does one the chosen kind doesn't
   * implement (`UnsupportedFrontDoorSettingError`).
   *
   * @example
   * ```ts
   * frontDoor: { features: { waf: { enabled: true }, priceClass: PriceClass.PRICE_CLASS_ALL } }
   * frontDoor: { kind: 'alb', certificate, features: { waf: { enabled: true }, logging: { enabled: true } } }
   * frontDoor: { kind: 'apiGateway', api: 'rest', features: { domain: { domainName: 'app.example.com', hostedZone: 'example.com' } } }
   * ```
   *
   * Omit for the CloudFront default (backward-compatible).
   *
   * (`StackedRouterDoorOptions` is the stacked door's router, which only the
   * `@aws-blocks/core` `Hosting` builds — not an option for apps.)
   */
  frontDoor?: HostingFrontDoor | StackedRouterDoorOptions;
  /**
   * The backend API a non-CloudFront door proxies same-origin, so the browser
   * reaches it on the app's own origin (session cookies flow, no CORS): the
   * ALB through a forwarder Lambda, API Gateway natively, a bring-your-own
   * door as `input.origins.api`. The `@aws-blocks/core` `Hosting` sets it from
   * its `api` prop. The CloudFront door (whose API behaviors the core
   * `Hosting` adds) and `'none'` (the client calls the API cross-origin)
   * ignore it.
   */
  backendApi?: {
    /** The backend's full API URL, ending in `/aws-blocks/api` (e.g. `https://{id}.execute-api.{region}.amazonaws.com/prod/aws-blocks/api`). */
    url: string;
    /**
     * Path patterns beyond `/aws-blocks/*` that must reach the backend (its
     * raw routes, e.g. `/hooks/*`). `/aws-blocks/*` is always included.
     */
    paths?: readonly string[];
  };

  /**
   * Build no image-optimization function, even when the manifest declares
   * one. On the API Gateway HTTP door the framework image endpoints
   * (`/_next/image`, `/_ipx/*`, `/_image`) are then answered by the asset
   * proxy with the source image, unoptimized; a remote source is redirected
   * to itself when its host is in the manifest's image allowlist
   * (`imageOptimization.domains` / `remotePatterns`), else 404. Set by core
   * `Hosting` for `imageOptimization: false` (`HostingPresets.preview`).
   * @default false
   */
  skipImageOptimization?: boolean;
  // NOTE: S3-website is not a public front-door *kind* — it is an ORIGIN, not a
  // front door (it fronts nothing). It is surfaced as `frontDoor: 'none'` (serve
  // the origin directly); `s3-website` is the internal door name
  // (`s3WebsiteDoor`), never part of this public union.
};

// ---- Main construct ----

/**
 * Unified, manifest-driven hosting construct.
 *
 * Always creates: S3 bucket (private, BLOCK_ALL) and an atomic deployment with
 * Build ID, and the front door (`frontDoor`): by default a CloudFront
 * distribution with OAC; an ALB, an API Gateway, an S3 website (`'none'`) or a
 * bring-your-own door instead.
 *
 * Provisions based on manifest content:
 * - compute entries → Lambda functions (handler/http-server/edge types)
 * - cache config → S3 cache bucket + DynamoDB tags table + SQS revalidation queue
 * - imageOptimization → separate image Lambda
 * - middleware → Lambda\@Edge or CloudFront Function
 * - domain config → ACM certificate + Route 53 + CF aliases
 * - waf.enabled → WAFv2 WebACL
 */
export class HostingConstruct extends Construct {
  readonly bucket: Bucket;
  /** Backs {@link distribution}; set only for the CloudFront front door. */
  private readonly _distribution?: Distribution;
  /**
   * The CloudFront distribution.
   *
   * Available for the default `cloudfront` front door. Any other door (`alb`,
   * `apiGateway`, `'none'`, a custom door) has no built-in distribution, so
   * reading it throws — check `frontDoorKind === 'cloudfront'` first (a
   * bring-your-own door may use any `service` id, `cloudfront` included), or
   * use `distributionUrl` / `frontDoor` for the deploy's address.
   *
   * @throws HostingError('FrontDoorNotCloudFrontError') when the front door is not CloudFront.
   */
  get distribution(): Distribution {
    if (!this._distribution) {
      throw new HostingError('FrontDoorNotCloudFrontError', {
        message: `HostingConstruct.distribution is only available for the CloudFront front door; this deploy uses the '${this.frontDoorKind}' door ('${this.frontDoor.service}').`,
        resolution: 'Use `distributionUrl` (or `frontDoor.url`) for the address, or read `distribution` only when `frontDoorKind` is `cloudfront`.',
      });
    }
    return this._distribution;
  }
  /**
   * The kind of front door serving the deploy, resolved from `frontDoor`:
   * `'cloudfront'` (the default), `'none'`, `'alb'` (also the stacked door's
   * router), `'apiGateway'` or `'custom'`. Branch on this, not on
   * `frontDoor.service` — a bring-your-own door's `service` is free-form.
   */
  readonly frontDoorKind: FrontDoorKind;
  /**
   * The Application Load Balancer's DNS name, present only when the front door
   * is the built-in ALB (`frontDoor: { kind: 'alb' }`, or the stacked door's
   * router). Absent for every other door, a bring-your-own one included (read
   * its address from `frontDoor.originHandle`). The stacked door's edge points
   * its router origin at it.
   */
  readonly loadBalancerDnsName?: string;
  /**
   * The {@link DoorInput} the front door was built from — the app facts, the
   * provisioned origins, and the features the app asked for. A door stacked in
   * front of this one (the CloudFront edge of the stacked door) is built from
   * the same input, plus `upstream`.
   */
  readonly doorInput: DoorInput;
  /**
   * How the front door invokes the server-rendering compute: `'buffered'` for a
   * door that invokes it without streaming (ALB, API Gateway HTTP API, a custom
   * door with `serverResponse: 'buffered'`), else `'streaming'`.
   */
  readonly serverResponse: 'streaming' | 'buffered';

  /**
   * What the selected door can serve (streaming, wildcard routes, the app's
   * rules on every response), read by the synth checks.
   *
   * @internal Framework-only.
   */
  readonly doorCapabilities: DoorCapabilities;
  /**
   * What the front door handed back: its service id, public `url`, and the
   * `originHandle` a door stacked in front of it attaches to.
   */
  readonly frontDoor: { readonly service: string; readonly url: string; readonly originHandle: OriginHandle };
  /**
   * The PUBLIC website bucket, present only for `frontDoor: 'none'` (served
   * directly from S3 website hosting — its own public bucket, from root). The Blocks
   * wrapper publishes `config.json` here so a cross-origin SPA reads the absolute
   * API URL from the origin it loads from. Absent for every other door.
   */
  readonly websiteBucket?: import('aws-cdk-lib/aws-s3').IBucket;
  readonly distributionUrl: string;
  /**
   * The security-headers / CSP policy applied to this distribution's static,
   * SSR and image behaviors. Exposed so `core.Hosting` can attach the same
   * policy to the API/auth proxy behaviors it adds when it fronts the backend,
   * keeping every behavior on the distribution covered by one policy.
   *
   * Only the CloudFront door builds a distribution here, so it is `undefined`
   * behind every other door: the stacked door's edge (built by `core.Hosting`)
   * carries its own policy on every behavior, the API's included, and a
   * bring-your-own door attaches its own.
   */
  get securityHeadersPolicy(): IResponseHeadersPolicy | undefined {
    return this.cdn?.securityHeadersPolicy;
  }
  /**
   * Physical id of the `/*` CloudFront invalidation issued on a compute deploy
   * (a CDK token), or `undefined` for a pure-static deploy. Surfaced so the L3
   * owner can output it for a post-deploy `GetInvalidation` liveness poll.
   */
  readonly invalidationId?: string;
  /**
   * The immutable Build ID for this deploy. Static assets live under
   * `builds/<buildId>/`; a composed router layer (e.g. the CF → ALB → infra
   * front door) reads it to prefix the same asset keys.
   */
  readonly buildId: string;
  readonly computeFunctions: Map<string, LambdaFunction | experimental.EdgeFunction> = new Map();
  private readonly cdn?: CdnConstruct;
  readonly computeFunctionUrls: Map<string, FunctionUrl> = new Map();
  /**
   * `live` aliases for compute resources with provisioned concurrency.
   * Passed to the CDN so the SSR REST API integration targets the warm
   * alias instead of `$LATEST`.
   */
  readonly computeAliases: Map<string, Alias> = new Map();
  /**
   * SSR compute running on AWS Lambda Web Functions (`compute.type:
   * 'web-function'`), keyed by compute name. These are NOT in
   * {@link computeFunctions}, which holds Lambda functions only.
   */
  readonly computeWebFunctions: Map<string, WebFunctionConstruct> = new Map();
  readonly certificate?: ICertificate;
  readonly hostedZone?: IHostedZone;
  readonly webAcl?: CfnWebACL;
  readonly cacheTable?: Table;
  readonly revalidationQueue?: Queue;
  readonly buildCacheBucket?: Bucket;
  readonly revalidationDlq?: Queue;
  readonly cacheBucket?: Bucket;
  /**
   * Monitoring surface, set when monitoring is on (the default).
   *
   * - `alarms`: every CloudWatch alarm created, across both regions
   *   (includes the us-east-1 CloudFront alarm off-region). Attach
   *   custom actions via `alarms.forEach(a => a.addAlarmAction(...))`.
   * - `alarmTopics`: the alarm SNS topics (the app-region topic, plus
   *   the us-east-1 topic off-region). Subscriptions passed via
   *   `monitoring.subscriptions` are already attached to all of them;
   *   this is for advanced callers who want the raw topics.
   *
   * Not declared `readonly` because the `MonitoringConstruct` that owns
   * these is built mid-constructor (after the SSR / image-opt Lambdas it
   * alarms on are wired up). Treat it as logically immutable
   * post-construction — do not reassign from outside the constructor.
   */
  monitoring?: {
    alarms: Alarm[];
    alarmTopics: ITopic[];
  };

  /**
   * Registers a dependency that must finish before the new build becomes
   * reachable through the KVS route table.
   *
   * On every door, the resources the door's `onUpload` declared (e.g. a
   * `cf.invalidate`) also wait for it, as they wait for the asset uploads —
   * the `@aws-blocks/core` `Hosting` registers its resolved runtime-config
   * upload here, so an invalidation never runs before the real
   * `config.json` is in place.
   */
  addBuildAssetDependency(dependency: IDependable): void {
    // CloudFront: gate the KVS route table on it. Every door: whatever its
    // `onUpload` declared (e.g. a `cf.invalidate`) runs after it, as after the
    // asset uploads.
    this.cdn?.addBuildAssetDependency(dependency);
    for (const c of this.postUploadConstructs) c.node.addDependency(dependency);
  }

  /** The constructs the door's `onUpload` declared; each runs after every upload (see {@link addBuildAssetDependency}). */
  private readonly postUploadConstructs: IConstruct[] = [];

  /**
   * Creates the hosting infrastructure from a framework-agnostic deploy manifest.
   */
  constructor(scope: Construct, id: string, props: HostingConstructProps) {
    super(scope, id);

    const { manifest } = props;
    // Rewrites (upstream proxy): adapters lift `routeRules.proxy` (Nitro) and
    // similar upstream-proxy rules into `manifest.rewrites[]`. The L3 doesn't
    // yet provision the edge-optimized path (per-pattern `HttpOrigin` +
    // CloudFront-Function origin-rewrite) — BUT these rules still WORK:
    // proxied requests fall through to the catch-all SSR route, where the
    // bundled Nitro runtime relays them to the upstream. So we warn (not
    // throw): the app deploys and proxies correctly; it just pays one SSR
    // Lambda invocation per proxied request instead of routing at the edge.
    // Throwing here would block a deployable, working app.
    if (manifest.rewrites && manifest.rewrites.length > 0) {
      process.stderr.write(
        `⚠️  Hosting: ${manifest.rewrites.length} upstream-proxy rewrite rule(s) ` +
          `(e.g. Nitro routeRules.proxy) are not edge-optimized yet — they are ` +
          `relayed by the SSR Lambda at runtime (one invocation per proxied ` +
          `request) rather than routed directly at CloudFront. The rules still ` +
          `work; this is a cost/latency note, not an error.\n`,
      );
    }
    const buildId = manifest.buildId ?? generateBuildId();
    this.buildId = buildId;

    // A bare REST API URL carries its stage (`https://{id}.execute-api…/prod/`),
    // but an app links from the root (`/assets/…`, `/aws-blocks/api`,
    // `/.blocks-sandbox/config.json`), and those miss the stage (403). A
    // custom domain's base-path mapping serves the stage at the domain root.
    // The door's effective settings: `frontDoor.features` plus the deprecated
    // top-level aliases (`domain`, `waf`, `cdn.*`, `logging`, `monitoring`,
    // `skewProtection`). Everything below reads the settings from here.
    const resolved = resolveHostingFrontDoor(props);
    const f = resolved.features;
    const cdnWebAclArn = resolved.cdnWebAclArn;
    this.frontDoorKind = resolved.kind;
    // The stacked door's router: the ALB, locked to the CloudFront edge in front.
    const stackedRouter = typeof props.frontDoor === 'object' && props.frontDoor?.kind === 'stackedRouter';

    assertRestDoorAddressable(props.frontDoor, f.domain);
    assertAlbCertificateHasDomain(props.frontDoor, f.domain);
    assertComputeReachableByDoor(props.compute?.type, resolved.kind, stackedRouter ? 'stacked' : resolved.kind);
    assertMiddlewareReachableByDoor(manifest, resolved.kind, stackedRouter ? 'stacked' : resolved.kind);
    this.doorCapabilities = doorCapabilitiesFor(props.frontDoor);
    assertServerReachableByDoor(
      manifest,
      this.doorCapabilities,
      stackedRouter ? 'stacked' : resolved.kind === 'apiGateway' ? 'apiGateway (HTTP API)' : resolved.kind,
    );

    // Skew-protection cookie must not outlive the build artifacts it pins
    // to. A `maxAge` longer than `buildRetentionDays` lets a returning
    // viewer present a cookie for a build whose `builds/<id>/` prefix the
    // S3 lifecycle rule has already deleted → hard 403 on every asset.
    if (f.skewProtection?.enabled && f.skewProtection.maxAge) {
      const retentionDays = props.storage?.buildRetentionDays ?? DEFAULT_BUILD_RETENTION_DAYS;
      const retentionSeconds = retentionDays * 24 * 60 * 60;
      if (f.skewProtection.maxAge > retentionSeconds) {
        throw new HostingError('InvalidSkewProtectionMaxAgeError', {
          message: `skewProtection.maxAge (${f.skewProtection.maxAge}s) exceeds storage.buildRetentionDays (${retentionDays}d = ${retentionSeconds}s).`,
          resolution:
            'Lower skewProtection.maxAge to at most storage.buildRetentionDays (in seconds), or raise storage.buildRetentionDays. A cookie that outlives the build prefix pins returning viewers to a deleted build → 403.',
        });
      }
    }

    // #480: advisory (NOT fatal) — a deploy cadence at or beyond the retention
    // window means a superseded build can age out before the next deploy,
    // shrinking the rollback window. The IN-SERVICE build is never expired
    // (only superseded builds carry the lifecycle tag), so this is a
    // rollback-window note, not a 403 risk — hence warn, not throw (mirrors the
    // rewrite-proxy warning above: never block a deployable, working app).
    const deployIntervalDays = props.storage?.deployIntervalDays;
    if (deployIntervalDays != null) {
      const retentionDays = props.storage?.buildRetentionDays ?? DEFAULT_BUILD_RETENTION_DAYS;
      if (deployIntervalDays >= retentionDays) {
        process.stderr.write(
          `⚠️  Hosting: storage.deployIntervalDays (${deployIntervalDays}d) is >= ` +
            `storage.buildRetentionDays (${retentionDays}d). Superseded builds may be ` +
            `expired before your next deploy, shrinking the rollback window. The build ` +
            `currently being served is unaffected. Raise storage.buildRetentionDays to ` +
            `keep more rollback targets available.\n`,
        );
      }
    }

    // Normalize `compute.timeout` once: callers consuming the L3 from
    // JS-compiled wrappers (or strict TS users who write
    // `timeout: 30`) often pass a plain number, which then crashes
    // deep inside aws-cdk-lib with `props.timeout.toSeconds is not a
    // function`. Accepting a number here and coercing to `Duration`
    // turns that into a forgiving, well-typed surface.
    const computeTimeout = normalizeTimeout(props.compute?.timeout);

    // ---- 1. Storage (S3 buckets) ----
    const storage = new StorageConstruct(this, 'Storage', {
      retainOnDelete: props.storage?.retainOnDelete,
      accessLogging: f.logging?.enabled ?? true,
      accessLogVersion: f.logging?.version,
      encryption: props.storage?.encryption,
      encryptionKey: props.storage?.encryptionKey,
      buildRetentionDays: props.storage?.buildRetentionDays,
      logRetentionDays: f.logging?.retentionDays,
      // 3.2 — adapter-supplied lifecycle rules; storage construct
      // turns each `{prefix, days}` entry into an S3 lifecycle rule.
      extraLifecycleRules: manifest.lifecycle,
      // 3.3 — opt-in S3 inventory. Off by default. When enabled,
      // a daily CSV inventory of `builds/` lands in the access log
      // bucket so operators can audit per-build sizes.
      inventoryEnabled: props.storage?.inventory?.enabled === true,
    });
    this.bucket = storage.bucket;

    // ---- 2. Compute resources ----
    const computeEntries = Object.entries(manifest.compute);
    const hasCompute = computeEntries.length > 0;
    // How the selected door invokes the server, known before the compute is
    // built: a door that invokes it without streaming gets a buffered server.
    const serverResponse = serverResponseFor(props.frontDoor);
    this.serverResponse = serverResponse;

    for (const [name, resource] of computeEntries) {
      if (resource.type === 'edge') {
        const edgeConstruct = new ComputeConstruct(this, `Compute-${name}`, {
          name,
          computeResource: resource,
          memorySize: props.compute?.memorySize,
          timeout: computeTimeout,
          reservedConcurrency: props.compute?.reservedConcurrency,
          logRetention: props.compute?.logRetention,
          skipRegionValidation: props.skipRegionValidation,
          environment: props.compute?.environment,
        });
        this.computeFunctions.set(name, edgeConstruct.function);
        continue;
      }

      // SSR compute is fronted by REST API (cdn_construct.ts), not by a
      // Function URL. Image-opt etc. keep OAC + Function URL.
      const isSsrCompute = name === 'default' || name === 'server';

      // Web Functions host the SSR server only; auxiliary compute (image
      // optimization, revalidation, edge) stays on Lambda.
      if (isSsrCompute && props.compute?.type === 'web-function') {
        this.warnInapplicableWebFunctionOptions(props.compute);
        const webFunction = new WebFunctionConstruct(this, `WebCompute-${name}`, {
          name,
          computeResource: resource,
          timeout: computeTimeout,
          logRetention: props.compute.logRetention,
          skipRegionValidation: props.skipRegionValidation,
          environment: props.compute.environment,
          ...props.compute.webFunction,
        });
        this.computeWebFunctions.set(name, webFunction);
        continue;
      }

      const computeConstruct = new ComputeConstruct(this, `Compute-${name}`, {
        name,
        computeResource: isSsrCompute ? withDoorEventShim(resource, props.frontDoor) : resource,
        memorySize: props.compute?.memorySize,
        timeout: computeTimeout,
        reservedConcurrency: props.compute?.reservedConcurrency,
        // Forward the L3 user-facing provisioned-concurrency knob to the SSR
        // compute. Previously this was silently dropped — only a
        // manifest-level value (which adapters don't set from user input) was
        // honored, so `compute.provisionedConcurrency` was inert.
        provisionedConcurrency: isSsrCompute ? props.compute?.provisionedConcurrency : undefined,
        logRetention: props.compute?.logRetention,
        skipRegionValidation: props.skipRegionValidation,
        skipFunctionUrl: isSsrCompute,
        environment: props.compute?.environment,
        ...(isSsrCompute && serverResponse === 'buffered' ? { responseMode: 'buffered' as const } : {}),
      });

      this.computeFunctions.set(name, computeConstruct.function);
      if (computeConstruct.functionUrl) {
        this.computeFunctionUrls.set(name, computeConstruct.functionUrl);
      }
      if (computeConstruct.alias) {
        this.computeAliases.set(name, computeConstruct.alias);
      }
    }

    // ---- 3. Cache infrastructure (ISR) ----
    if (manifest.cache && manifest.cache.driver === 'nitro-s3') {
      // Nitro path: a single S3 bucket fronts Nitro's `useStorage('cache')`
      // mount via the plugin the adapter injected at build time. No DDB,
      // no SQS, no separate worker — Nitro handles refresh inline.
      this.cacheBucket = new Bucket(this, 'NitroCacheBucket', {
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        // Nitro stores its own per-key expiry inside each value;
        // this lifecycle rule is a safety net for orphaned objects.
        lifecycleRules: [{ expiration: Duration.days(7) }],
      });

      const cacheComputeName = manifest.cache.computeResource;
      const cacheFunction =
        this.computeFunctions.get(cacheComputeName) ?? this.computeWebFunctions.get(cacheComputeName);
      if (!cacheFunction) {
        throw new HostingError('CacheComputeResourceNotFoundError', {
          message: `Cache config references compute resource '${cacheComputeName}' but it was not found in manifest.compute`,
          resolution: 'Ensure cache.computeResource matches a key in the compute map.',
        });
      }
      this.cacheBucket.grantReadWrite(cacheFunction);

      if (cacheFunction instanceof LambdaFunction || cacheFunction instanceof WebFunctionConstruct) {
        cacheFunction.addEnvironment('HOSTING_NITRO_CACHE_BUCKET', this.cacheBucket.bucketName);
        cacheFunction.addEnvironment('HOSTING_NITRO_CACHE_REGION', Stack.of(this).region);
      }
    } else if (manifest.cache) {
      // OpenNext path (default when `driver` is absent or 'opennext').
      // S3 bucket for ISR cache
      this.cacheBucket = new Bucket(this, 'CacheBucket', {
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        lifecycleRules: [{ expiration: Duration.days(30) }],
      });

      // DynamoDB table for tag-based revalidation
      if (manifest.cache.tagRevalidation) {
        this.cacheTable = new Table(this, 'CacheTagTable', {
          partitionKey: { name: 'tag', type: AttributeType.STRING },
          sortKey: { name: 'path', type: AttributeType.STRING },
          billingMode: BillingMode.PAY_PER_REQUEST,
          removalPolicy: RemovalPolicy.DESTROY,
          timeToLiveAttribute: 'ttl',
        });

        // GSI required by OpenNext's tag cache handler for path-based lookups
        this.cacheTable.addGlobalSecondaryIndex({
          indexName: 'revalidate',
          partitionKey: { name: 'path', type: AttributeType.STRING },
          sortKey: { name: 'revalidatedAt', type: AttributeType.NUMBER },
        });
      }

      // SQS queue for async revalidation (FIFO required — OpenNext sends
      // MessageDeduplicationId and MessageGroupId with revalidation messages)
      if (manifest.cache.revalidationQueue) {
        // Hold a reference to the DLQ on the construct so the
        // monitoring construct can attach an alarm to it later.
        this.revalidationDlq = new Queue(this, 'RevalidationDLQ', {
          fifo: true,
          retentionPeriod: Duration.days(14),
          encryption: QueueEncryption.SQS_MANAGED,
        });

        this.revalidationQueue = new Queue(this, 'RevalidationQueue', {
          fifo: true,
          contentBasedDeduplication: true,
          visibilityTimeout: Duration.seconds(30),
          retentionPeriod: Duration.days(1),
          encryption: QueueEncryption.SQS_MANAGED,
          deadLetterQueue: {
            queue: this.revalidationDlq,
            maxReceiveCount: 3,
          },
        });

        new CfnOutput(this, 'RevalidationQueueUrl', {
          value: this.revalidationQueue.queueUrl,
          description: 'URL of the ISR revalidation SQS queue',
        });
      }

      // Revalidation worker Lambda — processes SQS messages to refresh stale pages
      if (manifest.cache.revalidationFunction && this.revalidationQueue) {
        const revalidationLogGroup = new LogGroup(this, 'RevalidationLogGroup', {
          retention: props.compute?.logRetention ?? RetentionDays.TWO_WEEKS,
          removalPolicy: RemovalPolicy.DESTROY,
        });

        const revalidationFn = new LambdaFunction(this, 'RevalidationFunction', {
          runtime: DEFAULT_NODE_RUNTIME,
          handler: manifest.cache.revalidationFunction.handler,
          code: Code.fromAsset(manifest.cache.revalidationFunction.bundle),
          timeout: Duration.seconds(30),
          memorySize: 256,
          logGroup: revalidationLogGroup,
          environment: {
            CACHE_BUCKET_NAME: this.cacheBucket.bucketName,
            CACHE_BUCKET_REGION: Stack.of(this).region,
            OPEN_NEXT_BUILD_ID: buildId,
            ...(this.cacheTable ? { CACHE_DYNAMO_TABLE: this.cacheTable.tableName } : {}),
          },
        });

        this.cacheBucket.grantReadWrite(revalidationFn);
        if (this.cacheTable) {
          this.cacheTable.grantReadWriteData(revalidationFn);
        }

        revalidationFn.addEventSource(new SqsEventSource(this.revalidationQueue, { batchSize: 5 }));

        this.computeFunctions.set('revalidation', revalidationFn);
      }

      // Grant cache access to the target compute resource
      const cacheComputeName = manifest.cache.computeResource;
      const cacheFunction =
        this.computeFunctions.get(cacheComputeName) ?? this.computeWebFunctions.get(cacheComputeName);
      if (!cacheFunction) {
        throw new HostingError('CacheComputeResourceNotFoundError', {
          message: `Cache config references compute resource '${cacheComputeName}' but it was not found in manifest.compute`,
          resolution: 'Ensure cache.computeResource matches a key in the compute map.',
        });
      }
      this.cacheBucket.grantReadWrite(cacheFunction);
      if (this.cacheTable) {
        this.cacheTable.grantReadWriteData(cacheFunction);
      }
      if (this.revalidationQueue) {
        this.revalidationQueue.grantSendMessages(cacheFunction);
        this.revalidationQueue.grantConsumeMessages(cacheFunction);
      }

      // ISR environment variables
      if (cacheFunction instanceof LambdaFunction || cacheFunction instanceof WebFunctionConstruct) {
        cacheFunction.addEnvironment('CACHE_BUCKET_NAME', this.cacheBucket.bucketName);
        cacheFunction.addEnvironment('CACHE_BUCKET_REGION', Stack.of(this).region);
        cacheFunction.addEnvironment('OPEN_NEXT_BUILD_ID', buildId);
        if (this.cacheTable) {
          cacheFunction.addEnvironment('CACHE_DYNAMO_TABLE', this.cacheTable.tableName);
        }
        if (this.revalidationQueue) {
          cacheFunction.addEnvironment('REVALIDATION_QUEUE_URL', this.revalidationQueue.queueUrl);
          cacheFunction.addEnvironment('REVALIDATION_QUEUE_REGION', Stack.of(this).region);
        }
      }

      // ---- 3b. Seed the ISR cache (S3 + DynamoDB tag table) ----
      // Without seeding, every prerendered ISR/SSG page is a cold
      // on-demand render on first request (cache MISS) and tag-based
      // revalidation can't purge a page until it's been hit once. We
      // upload the build's prebuilt cache and seed the tag table so the
      // build-time prerender is actually used.
      if (manifest.cache.seedDirectory && this.cacheBucket) {
        // The on-disk layout is `<buildId>/<route>.cache`, which is
        // exactly the key the runtime reads (empty CACHE_BUCKET_KEY_PREFIX
        // + OPEN_NEXT_BUILD_ID namespacing), so upload preserves keys.
        // `prune: false` so we never delete a concurrent build's objects;
        // each build writes under its own `<buildId>/` prefix.
        new BucketDeployment(this, 'IsrCacheSeed', {
          sources: [Source.asset(manifest.cache.seedDirectory)],
          destinationBucket: this.cacheBucket,
          prune: false,
          // The cache blobs are not Cache-Control-sensitive (read by the
          // Lambda via the SDK, never served through CloudFront), but set
          // a private directive so an accidental public read is non-cacheable.
          cacheControl: [CacheControl.fromString('private, no-store')],
          // A large `generateStaticParams` fan-out (e.g. 1000 prerendered
          // product pages) produces thousands of small `.cache` files. CDK's
          // default 128 MB BucketDeployment Lambda uploads these at a crawl
          // (low memory → low network throughput) and the sync times out at
          // 900 s mid-upload, hanging the stack on the custom resource. More
          // memory yields proportionally more CPU + network bandwidth, so the
          // upload completes well within the window. Memory + timeout track
          // the seed size; cap timeout at the 15-min Lambda max.
          memoryLimit: 1024,
          ephemeralStorageSize: Size.gibibytes(2),
        });
      }

      if (manifest.cache.initFunction && this.cacheTable) {
        // OpenNext's dynamodb-provider is a CloudFormation custom-resource
        // handler: it reads its bundled `dynamodb-cache.json` and writes the
        // build's tag→path rows into CACHE_DYNAMO_TABLE on create/update.
        const initFn = new LambdaFunction(this, 'IsrTagTableSeedFn', {
          runtime: DEFAULT_NODE_RUNTIME,
          handler: manifest.cache.initFunction.handler,
          code: Code.fromAsset(manifest.cache.initFunction.bundle),
          timeout: Duration.minutes(5),
          memorySize: 512,
          environment: {
            CACHE_DYNAMO_TABLE: this.cacheTable.tableName,
            CACHE_BUCKET_REGION: Stack.of(this).region,
          },
        });
        this.cacheTable.grantReadWriteData(initFn);

        const initProvider = new Provider(this, 'IsrTagTableSeedProvider', {
          onEventHandler: initFn,
        });
        // `buildId` in the properties makes the custom resource re-run on
        // every new build (new prerendered tag set), not just on create.
        const initSeed = new CustomResource(this, 'IsrTagTableSeed', {
          serviceToken: initProvider.serviceToken,
          properties: { buildId },
        });
        // Retain the seed custom resource on stack DELETE so it is dropped
        // without a delete-time provider invoke. This is the same teardown-wedge
        // guard applied to the Custom::CDKBucketDeployment CRs below: a
        // provider-backed CR whose delete invoke can hang will wedge the whole
        // stack in DELETE_FAILED. Observed on long-lived e2e stacks whose seed CR
        // sat DELETE_IN_PROGRESS until the 30-min custom-resource timeout while
        // every other stack resource had already reached DELETE_COMPLETE.
        // Safe to retain: the seed only writes build-time tag->path rows into
        // the cache table, and that table is RemovalPolicy.DESTROY (above), so it
        // is destroyed with the stack regardless -- skipping the delete invoke
        // orphans no live resource. (RETAIN here only tells CFN to skip the
        // Delete and forget the logical CR; the backing provider Lambda is a
        // normal stack resource and still deletes with the stack.)
        initSeed.applyRemovalPolicy(RemovalPolicy.RETAIN);
      }
    }

    // ---- 4. Image optimization Lambda ----
    if (manifest.imageOptimization && !props.skipImageOptimization) {
      const imageConstruct = new ComputeConstruct(this, 'ImageOptimization', {
        name: 'image-optimization',
        computeResource: {
          type: 'handler',
          bundle: manifest.imageOptimization.bundle,
          handler: manifest.imageOptimization.handler,
          placement: 'regional',
          streaming: false,
          memorySize: 1024,
          timeout: 25,
        },
        // No reservation by default. Reserving concurrency here used to be
        // hardcoded to 10, which made deploys fail on fresh accounts whose
        // account-level unreserved limit is also 10. Operators who need to
        // cap image-opt can set `compute.imageOptimization.reservedConcurrency`.
        reservedConcurrency: props.compute?.imageOptimization?.reservedConcurrency,
        // Propagate the SSR Lambda's logRetention to image-opt so a
        // user who bumped retention for debugability gets the same
        // window for image-opt logs (intermittent SVG/SSRF rejects
        // and remote-pattern misses live here).
        logRetention: props.compute?.logRetention,
        skipRegionValidation: props.skipRegionValidation,
      });
      this.computeFunctions.set('image-optimization', imageConstruct.function);
      if (imageConstruct.functionUrl) {
        this.computeFunctionUrls.set('image-optimization', imageConstruct.functionUrl);
      }
      // Image optimization needs to read original images from the assets bucket
      this.bucket.grantRead(imageConstruct.function);

      // Environment variables required by OpenNext image optimization
      if (imageConstruct.function instanceof LambdaFunction) {
        imageConstruct.function.addEnvironment('BUCKET_NAME', this.bucket.bucketName);
        imageConstruct.function.addEnvironment('BUCKET_KEY_PREFIX', `builds/${buildId}`);
        imageConstruct.function.addEnvironment('BUCKET_REGION', Stack.of(this).region);
        // Adapter-supplied env (e.g. IPX_BASE_URL for @nuxt/image
        // when the user customizes `runtimeConfig.ipx.baseURL`).
        if (manifest.imageOptimization.environment) {
          for (const [key, value] of Object.entries(manifest.imageOptimization.environment)) {
            imageConstruct.function.addEnvironment(key, value);
          }
        }

        // Image-opt safety knobs (Piece 4). These mirror the
        // user-facing names from Next.js / Astro. OpenNext's image-opt
        // adapter reads its config from a bundled `nextConfig` rather
        // than process env, so these env vars are written here for
        // forward-compat — the framework-side runtime can pick them up
        // when it migrates to env-based config.
        if (manifest.imageOptimization.dangerouslyAllowSVG !== undefined) {
          imageConstruct.function.addEnvironment(
            'IMAGE_ALLOW_SVG',
            String(manifest.imageOptimization.dangerouslyAllowSVG),
          );
        }
        if (manifest.imageOptimization.minimumCacheTTL !== undefined) {
          imageConstruct.function.addEnvironment(
            'IMAGE_MIN_CACHE_TTL',
            String(manifest.imageOptimization.minimumCacheTTL),
          );
        }
        if (manifest.imageOptimization.remotePatterns && manifest.imageOptimization.remotePatterns.length > 0) {
          imageConstruct.function.addEnvironment(
            'IMAGE_REMOTE_PATTERNS',
            JSON.stringify(manifest.imageOptimization.remotePatterns),
          );
        }
        // Astro `image.domains` / Next.js `images.domains` ship as a
        // CSV of bare hostnames — simpler shape than remotePatterns,
        // honored by the IPX runtime allowlist (P0.1 enforcement).
        if (manifest.imageOptimization.domains && manifest.imageOptimization.domains.length > 0) {
          imageConstruct.function.addEnvironment(
            'IMAGE_ALLOWED_HOSTNAMES',
            manifest.imageOptimization.domains.join(','),
          );
        }
        // 4.1 — Image-opt parity with framework knobs. The manifest
        // already carries the framework's resolved `formats` and
        // `sizes` (Next: `images.formats`/`deviceSizes`; Astro: same
        // shape via Astro 5 image config). Forward them to the IPX
        // runtime as CSV env so the Lambda emits only the formats /
        // sizes the framework expects. Today the IPX runtime ignores
        // these (forward-compat); when the runtime starts honoring
        // them, no CDK churn is needed.
        if (manifest.imageOptimization.formats.length > 0) {
          imageConstruct.function.addEnvironment('IMAGE_FORMATS', manifest.imageOptimization.formats.join(','));
        }
        if (manifest.imageOptimization.sizes.length > 0) {
          imageConstruct.function.addEnvironment('IMAGE_DEVICE_SIZES', manifest.imageOptimization.sizes.join(','));
        }
      }
    }

    // ---- 5. Middleware (Lambda@Edge) ----
    let middlewareEdgeVersion: IVersion | undefined;
    if (manifest.middleware) {
      const middlewareConstruct = new ComputeConstruct(this, 'Middleware', {
        name: 'middleware',
        computeResource: {
          type: 'edge',
          bundle: manifest.middleware.bundle,
          handler: manifest.middleware.handler,
          placement: 'global',
          streaming: false,
          timeout: 5,
          memorySize: 128,
        },
        // Lambda@Edge logs land in us-east-1 + every PoP region. The
        // L3 still passes logRetention so all replicas honor the same
        // window — the singleton custom-resource-driven retention
        // would have churned per-region log groups on every redeploy.
        logRetention: props.compute?.logRetention,
        skipRegionValidation: props.skipRegionValidation,
      });
      this.computeFunctions.set('middleware', middlewareConstruct.function);
      middlewareEdgeVersion = middlewareConstruct.function.currentVersion;
    }

    // ---- 5a. User-provided environment variables (applied to ALL compute functions) ----
    const RESERVED_PREFIXES = ['AWS_', 'HOSTING_', 'OPEN_NEXT_', 'CACHE_', 'REVALIDATION_', 'NODE_', 'LAMBDA_'];
    const RESERVED_EXACT_KEYS = new Set(['_HANDLER', 'LD_PRELOAD', '_X_AMZN_TRACE_ID']);
    const KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

    if (props.environment) {
      // Split plain strings / managed markers (secret|config) / BYO handles.
      // Managed + BYO are wired at runtime; domain markers are pre-resolved by the
      // async wrapper layer before construction.
      const { plain, managed, byo } = partitionEnvironment(props.environment);
      const storeConfig: StoreConfig = { secretStore: props.secretStore, configStore: props.configStore };

      for (const key of Object.keys(plain)) {
        if (!KEY_PATTERN.test(key)) {
          throw new HostingError('InvalidEnvironmentKeyError', {
            message: `Environment variable key '${key}' contains invalid characters.`,
            resolution:
              'Keys must match [a-zA-Z_][a-zA-Z0-9_]* (letters, numbers, underscores only, cannot start with a number).',
          });
        }
        if (RESERVED_PREFIXES.some((p) => key.startsWith(p))) {
          throw new HostingError('ReservedEnvironmentKeyError', {
            message: `Environment variable key '${key}' uses a reserved prefix.`,
            resolution: `Keys starting with ${RESERVED_PREFIXES.join(', ')} are reserved for internal use.`,
          });
        }
        if (RESERVED_EXACT_KEYS.has(key)) {
          throw new HostingError('ReservedEnvironmentKeyError', {
            message: `Environment variable key '${key}' is a reserved runtime key.`,
            resolution: `The key '${key}' is reserved by the Lambda runtime and cannot be overridden.`,
          });
        }
        if (key.length > 256) {
          throw new HostingError('EnvironmentKeyTooLongError', {
            message: `Environment variable key '${key}' exceeds 256 character limit.`,
            resolution: 'Lambda environment variable keys must be 256 characters or fewer.',
          });
        }
        const value = plain[key];
        if (value.length > 8192) {
          throw new HostingError('EnvironmentValueTooLongError', {
            message: `Environment variable value for '${key}' exceeds 8KB limit.`,
            resolution: 'Lambda environment variable values must be 8192 characters or fewer.',
          });
        }
      }

      for (const [, fn] of this.envTargets()) {
        for (const [key, value] of Object.entries(plain)) {
          fn.addEnvironment(key, value);
        }
        // Managed markers (secret|config): inject the store locator + grant read/decrypt.
        for (const marker of managed) {
          wireManagedValue(fn, marker, storeConfig);
        }
        // BYO handles (ISecret|IParameter): grant via the handle + inject its locator.
        for (const binding of byo) {
          wireByo(fn, binding, storeConfig);
        }
      }
    }

    // ---- 5b. OpenTelemetry env hooks (4.1) ----
    // When the user opts into `compute.tracing`, stamp the OTEL_*
    // env vars onto every regional Lambda the construct created.
    // The construct does NOT install any OTel SDK — instrumentation
    // is the user's responsibility (drop-in via NODE_OPTIONS,
    // OpenTelemetry Lambda Layer, manually wired SDK, etc.). All
    // we do here is honor the contract the OTel collector ecosystem
    // expects: OTEL_EXPORTER_OTLP_ENDPOINT / _HEADERS / OTEL_SERVICE_NAME.
    //
    // Lambda@Edge functions are skipped — Lambda@Edge does not
    // support env vars (the runtime simply discards them).
    if (props.compute?.tracing) {
      const tracing = props.compute.tracing;
      const serviceName = tracing.serviceName ?? 'hosting';
      for (const [name, fn] of this.envTargets()) {
        fn.addEnvironment('OTEL_EXPORTER_OTLP_ENDPOINT', tracing.otelEndpoint);
        if (tracing.otelHeaders) {
          fn.addEnvironment('OTEL_EXPORTER_OTLP_HEADERS', tracing.otelHeaders);
        }
        // Per-function service name disambiguates traces in
        // collectors that aggregate by service. e.g. `<base>-ssr`,
        // `<base>-image-optimization`, `<base>-revalidation`.
        fn.addEnvironment(
          'OTEL_SERVICE_NAME',
          name === 'default' || name === 'server' ? `${serviceName}-ssr` : `${serviceName}-${name}`,
        );
      }
    }

    // ---- 5c. Synthetic warmup schedule (2.1) ----
    // EventBridge schedule → SSR Lambda invoke every N. Customers
    // using `provisionedConcurrency` are already warm, so we skip
    // the warmup wiring there to avoid double-paying. Image-opt and
    // revalidation are not warmed by default — they're inherently
    // bursty and provisioned-concurrency is a better fit.
    if (
      props.compute?.warmup &&
      // Skip warmup when provisioned concurrency keeps the SSR Lambda warm —
      // whether set via the L3 prop or a manifest compute resource.
      !props.compute?.provisionedConcurrency &&
      !manifest.compute.default?.provisionedConcurrency &&
      !manifest.compute.server?.provisionedConcurrency
    ) {
      const ssrComputeName = this.computeFunctions.has('default')
        ? 'default'
        : this.computeFunctions.has('server')
          ? 'server'
          : undefined;
      const ssrFn = ssrComputeName ? this.computeFunctions.get(ssrComputeName) : undefined;
      // Warmup only applies to `handler`-type compute (OpenNext): the
      // synthetic event is a raw JSON object the handler can detect and
      // short-circuit. `http-server` compute (Nitro / Astro behind the
      // Lambda Web Adapter) expects an HTTP-shaped event — a raw JSON
      // payload would 500 on every warmup invoke, turning a cost
      // optimization into an error-rate generator. Skip it (and warn)
      // rather than synthesize an HTTP event we'd have to keep in sync
      // with LWA's expected shape.
      const ssrComputeType = ssrComputeName ? manifest.compute[ssrComputeName]?.type : undefined;
      if (ssrFn instanceof LambdaFunction && ssrComputeType === 'handler') {
        const rule = new Rule(this, 'WarmupSchedule', {
          schedule: Schedule.rate(props.compute.warmup.rate),
          description: '2.1 — keep SSR Lambda warm with a synthetic invoke every N.',
        });
        // The synthetic event carries a marker header so the user's
        // SSR handler can short-circuit (skip rendering work, skip
        // logging the invocation as production traffic).
        rule.addTarget(
          new LambdaFunctionTarget(ssrFn, {
            event: RuleTargetInput.fromObject({
              source: 'hosting-warmup',
              version: '1',
            }),
          }),
        );
      } else if (ssrFn instanceof LambdaFunction && ssrComputeType) {
        process.stderr.write(
          `⚠️  Hosting: compute.warmup is set but the SSR compute is '${ssrComputeType}' ` +
            `(not 'handler'). Warmup is skipped — a synthetic JSON invoke would error on a ` +
            `Lambda Web Adapter (http-server) function. Use provisionedConcurrency to keep ` +
            `http-server SSR warm.\n`,
        );
      }
    }

    // ---- Front-door selection ----
    // Which front door serves the deploy: CloudFront (the default: `undefined`,
    // `'cloudfront'`, `{ features }`) or any other door. Storage, compute,
    // cache, image (sections 1-5) and the error-page and asset uploads
    // (sections 11-12) are built for every door; section 12 is skipped for a
    // door that serves its own public bucket (`'none'`). The CloudFront branch
    // below builds the WAF, DNS, the security-headers policy, the CDN
    // distribution and OPEN_NEXT_ORIGIN; every other door is a free-form door
    // (`buildFrontDoor`) rendering the same neutral HostingPlan.
    const isCloudFront = resolved.kind === 'cloudfront';
    let cdn: CdnConstruct | undefined;
    // A door's post-upload hook (`FrontDoorResult.onUpload`), called once every
    // asset upload below has been declared (section 12d).
    let onUpload: FrontDoorResult['onUpload'];
    // The constructs that switch traffic to the new build (`FrontDoorResult.cutover`).
    let cutover: readonly IConstruct[] = [];

    if (isCloudFront) {
      // ---- 6. WAF (conditional) ----
      // Determine effective WebACL ARN: waf.webAclArn > cdn.webAclArn > create new
      const effectiveWebAclArn = f.waf?.webAclArn ?? cdnWebAclArn;
      if (!effectiveWebAclArn) {
        const wafConstruct = new WafConstruct(this, 'Waf', {
          enabled: f.waf?.enabled ?? false,
          rateLimit: f.waf?.rateLimit,
          skipRegionValidation: props.skipRegionValidation,
        });
        this.webAcl = wafConstruct.webAcl;
      }

      // ---- 7. Custom domain resources (conditional) ----
      const dnsConstructs: DnsConstruct[] = [];
      let resolvedDomainNames: string[] = [];
      const domain = f.domain;
      if (domain) {
        // Resolve domain names from single string or array
        resolvedDomainNames = Array.isArray(domain.domainName)
          ? domain.domainName
          : [domain.domainName];

        // Create DNS construct for the first/primary domain (handles certificate)
        const primaryDomain = resolvedDomainNames[0];
        const primaryDns = new DnsConstruct(this, 'Dns', {
          domainName: primaryDomain,
          hostedZone: domain.hostedZone,
          hostedZoneId: domain.hostedZoneId,
          certificate: domain.certificate,
          skipRegionValidation: props.skipRegionValidation,
        });
        dnsConstructs.push(primaryDns);
        this.certificate = primaryDns.certificate;
        this.hostedZone = primaryDns.hostedZone;

        // Additional domains share the same certificate but get separate DNS records
        for (let i = 1; i < resolvedDomainNames.length; i++) {
          const additionalDns = new DnsConstruct(this, `Dns${i + 1}`, {
            domainName: resolvedDomainNames[i],
            hostedZone: domain.hostedZone,
            hostedZoneId: domain.hostedZoneId,
            certificate: primaryDns.certificate,
            skipRegionValidation: props.skipRegionValidation,
          });
          dnsConstructs.push(additionalDns);
        }
      }

      // ---- 8. Security headers ----
      // Policy selection priority:
      //   1. BYO policy via `cdn.responseHeadersPolicy` — share across stacks.
      //   2. Custom policy when `cdn.contentSecurityPolicy` is configured.
      //   3. Managed SECURITY_HEADERS policy (default) — consumes no quota.
      //
      // The account-level ResponseHeadersPolicy limit is 20 (soft, raisable
      // to 200). Using the managed policy by default avoids quota exhaustion
      // when many hosting stacks deploy to the same account. The managed
      // policy includes HSTS, X-Content-Type-Options, X-Frame-Options,
      // X-XSS-Protection, and Referrer-Policy. CSP is intentionally omitted
      // from the default — frameworks (Next.js, Nuxt) emit their own CSP via
      // response headers, and a blanket L3 CSP would conflict.
      //
      // A Web Function names its internal log stream + revision in every
      // response (`lambda-web-logstream`). Strip it with the policy rather than a
      // viewer-response function: CloudFront skips viewer-response functions on
      // 4xx/5xx origin responses, but applies response headers policies to all.
      // The request id (`lambda-web-request-id`) stays, like API Gateway's
      // `x-amzn-requestid`, for support correlation.
      const removeOriginHeaders = this.computeWebFunctions.size > 0 ? [...WEB_FUNCTION_INTERNAL_HEADERS] : [];
      let securityHeadersPolicy: IResponseHeadersPolicy;
      if (f.responseHeadersPolicy) {
        securityHeadersPolicy = f.responseHeadersPolicy;
        if (removeOriginHeaders.length > 0) {
          Annotations.of(this).addWarningV2(
            '@aws-blocks/hosting:WebFunctionHeaderNotStripped',
            `cdn.responseHeadersPolicy is your own policy, so Hosting can't remove ${removeOriginHeaders.join(', ')} ` +
              "(internal Web Function log stream name) from responses. Make sure the policy's removeHeaders includes it " +
              '(a shared policy like this avoids one Hosting-created policy per stack).',
          );
        }
      } else if (f.contentSecurityPolicy) {
        securityHeadersPolicy = createSecurityHeadersPolicy(this, 'SecurityHeaders', {
          contentSecurityPolicy: f.contentSecurityPolicy,
          removeHeaders: removeOriginHeaders,
        });
      } else if (removeOriginHeaders.length > 0) {
        securityHeadersPolicy = createManagedEquivalentSecurityHeadersPolicy(this, 'SecurityHeaders', removeOriginHeaders);
      } else {
        securityHeadersPolicy = ResponseHeadersPolicy.SECURITY_HEADERS;
      }

      // ---- 9. CloudFront distribution ----
      const manifestWithBuildId: DeployManifest = { ...manifest, buildId };

      // Per-route Lambda@Edge function versions (OpenNext edge routes). Only
      // computes with type === 'edge' get a `currentVersion` from the
      // EdgeFunction CDK construct — middleware is excluded because it has
      // its own dedicated wiring on the default behavior.
      const routeEdgeFunctions = new Map<string, IVersion>();
      for (const [name, resource] of Object.entries(manifest.compute)) {
        if (resource.type !== 'edge') continue;
        if (name === 'middleware') continue;
        const fn = this.computeFunctions.get(name);
        if (fn instanceof experimental.EdgeFunction) {
          routeEdgeFunctions.set(name, fn.currentVersion);
        }
      }

      const cdnProps: CdnConstructProps = {
        bucket: this.bucket,
        manifest: manifestWithBuildId,
        securityHeadersPolicy,
        contentSecurityPolicy: f.contentSecurityPolicy,
        computeFunctionUrls: this.computeFunctionUrls,
        computeFunctions: this.computeFunctions,
        computeAliases: this.computeAliases,
        computeWebFunctions: this.computeWebFunctions,
        middlewareEdgeFunction: middlewareEdgeVersion,
        routeEdgeFunctions,
        webAcl: this.webAcl,
        certificate: this.certificate,
        domainName: resolvedDomainNames.length > 0 ? resolvedDomainNames : undefined,
        wwwRedirect: f.domain?.wwwRedirect,
        accessLogBucket: storage.accessLogBucket,
        accessLogVersion: f.logging?.version,
        accessLogPartitioning: f.logging?.partitioning,
        accessLogFormat: f.logging?.format,
        skipLoggingRegionValidation: props.skipRegionValidation,
        priceClass: f.priceClass,
        geoRestriction: f.geoRestriction,
        skewProtection: f.skewProtection ?? { enabled: true },
        ssrDefaultTtl: f.ssrDefaultTtl,
        cacheKeyCookies: f.cacheKeyCookies,
        cacheKeyHeaders: f.cacheKeyHeaders,
        webAclArn: effectiveWebAclArn ?? cdnWebAclArn,
        quotas: f.quotas,
        customErrorPages: props.errorPages
          ? {
              notFound: !!props.errorPages.notFound,
              serverError: !!props.errorPages.serverError,
            }
          : undefined,
      };

      // The CloudFront door is a free-form door like every other door: one
      // `build` that creates the CdnConstruct from `cdnProps` (the app's features
      // included, exactly as configured). It receives the same DoorInput a
      // bring-your-own door gets, plus that internal extra.
      const cfServerName = this.computeFunctions.has('default')
        ? 'default'
        : this.computeFunctions.has('server')
          ? 'server'
          : undefined;
      const cfPlan = buildHostingPlan({
        manifest,
        buildId,
        hasServer: Boolean(cfServerName),
        hasImage: this.computeFunctions.has('image-optimization'),
        skewEnabled: (f.skewProtection ?? { enabled: true }).enabled !== false,
        wwwRedirect: f.domain?.wwwRedirect,
      });
      this.doorInput = this.assembleDoorInput(cfPlan, manifest, props, resolved, cfServerName);
      const cfBuild = buildFrontDoor(this, cloudFrontDoor, { ...this.doorInput, cdnProps }, { wiringCheck: false });
      cdn = cfBuild.result.cdn;
      this.frontDoor = { service: cloudFrontDoor.service, url: cfBuild.result.url, originHandle: cfBuild.result.originHandle };

      this.cdn = cdn;
      this.invalidationId = cdn.invalidationId;
      this._distribution = cdn.distribution;
      this.distributionUrl = cdn.distributionUrl;

      // Output the CloudFront distribution domain when custom domain is configured.
      // BYO domain users need this to set up their external DNS CNAME.
      if (resolvedDomainNames.length > 0) {
        new CfnOutput(this, 'DistributionDomainName', {
          value: cdn.distribution.distributionDomainName,
          description: 'CloudFront distribution domain name. Point your DNS CNAME to this value.',
        });
      }

      // ---- Deletion ordering: Distribution before AccessLogBucket cleanup ----
      // CloudFront delivers access logs asynchronously. During stack deletion,
      // CDK's autoDeleteObjects Lambda can empty the bucket, but if the
      // distribution is still alive it writes MORE logs before being fully
      // removed — causing "bucket not empty" on the subsequent bucket delete.
      // Adding a DependsOn from the Distribution to the auto-delete custom
      // resource ensures CFN deletes the distribution FIRST (stopping log
      // delivery), THEN fires the auto-delete Lambda to empty the bucket.
      if (storage.accessLogBucket) {
        const autoDeleteCr = storage.accessLogBucket.node.tryFindChild('AutoDeleteObjectsCustomResource');
        if (autoDeleteCr) {
          cdn.distribution.node.addDependency(autoDeleteCr as Construct);
        }
      }

      // ---- 9c. Default CloudWatch alarms (P3.1 + P3.2) ----
      // Enabled by default — alarms cost cents/month idle and the
      // out-of-the-box visibility (CloudFront 5xx, Lambda errors/throttles,
      // image-opt errors, revalidation DLQ depth) is high-value during
      // the construct's validation phase. Opt out with
      // `monitoring: { enabled: false }`. When on, surfaces the SNS topic
      // ARN as a CloudFormation output so operators can wire subscriptions
      // externally without touching the construct again.
      const monitoringEnabled = f.monitoring?.enabled ?? true;
      if (monitoringEnabled) {
        const subscriptions = f.monitoring?.subscriptions ?? [];
        const ssrComputeName = this.computeFunctions.has('default')
          ? 'default'
          : this.computeFunctions.has('server')
            ? 'server'
            : undefined;
        const ssrFn = ssrComputeName ? this.computeFunctions.get(ssrComputeName) : undefined;
        const imgFn = this.computeFunctions.get('image-optimization');

        // CloudFront metrics only exist in us-east-1 and an alarm can't
        // watch a metric cross-region (issue #481). Off-region, defer the
        // CloudFront alarm to a dedicated us-east-1 support stack.
        //
        // NOTE on the three region cases:
        //   - region === 'us-east-1'      → alarm created locally (correct).
        //   - region resolved, off-region → alarm deferred to the us-east-1
        //     support stack below.
        //   - region UNRESOLVED (token)   → we cannot decide at synth where
        //     the app deploys, so the alarm is created locally. If that
        //     deploy target turns out NOT to be us-east-1, the alarm can
        //     never fire (the #481 bug). We can't fix that at synth, but we
        //     refuse to do it silently. Warn so it's visible in build
        //     output rather than a green-but-dead alarm.
        const hostingStack = Stack.of(this);
        const region = hostingStack.region;
        const regionResolved = !Token.isUnresolved(region);
        const offRegion = regionResolved && region !== 'us-east-1';

        if (!regionResolved && this._distribution) {
          Annotations.of(this).addWarningV2(
            '@aws-blocks/hosting:CloudFrontAlarmRegionUnresolved',
            `The hosting stack is environment-agnostic (region is an ` +
              `unresolved token), so the CloudFront 5xx alarm is created ` +
              `locally. AWS/CloudFront metrics only publish in us-east-1, so ` +
              `if this app deploys outside us-east-1 the alarm will never ` +
              `fire. Set env: { account, region } on the stack so the alarm ` +
              `can be placed in a us-east-1 support stack (issue #481).`,
          );
        }

        const monitoring = new MonitoringConstruct(this, 'Monitoring', {
          enabled: true,
          subscriptions,
          distribution: cdn.distribution,
          // Lambda@Edge functions don't accept the CW metric helpers we
          // use; only attach when the SSR compute is a regional Lambda.
          ssrFunction: ssrFn instanceof LambdaFunction ? ssrFn : undefined,
          imageFunction: imgFn instanceof LambdaFunction ? imgFn : undefined,
          revalidationDlq: this.revalidationDlq,
          createCloudFrontAlarmLocally: !offRegion,
        });

        const alarmTopics: ITopic[] = monitoring.topic ? [monitoring.topic] : [];
        const alarms: Alarm[] = [...monitoring.alarms];

        if (monitoring.topic) {
          new CfnOutput(this, 'MonitoringTopicArn', {
            value: monitoring.topic.topicArn,
            description: 'SNS topic for hosting alarms. Subscribe via monitoring.subscriptions, or an email/Slack/PagerDuty endpoint here.',
          });
        }

        // Off-region: place the CloudFront alarm in a us-east-1 support
        // stack, always (no opt-out). The same subscriptions are applied to
        // its topic so callers subscribe in one place and both topics are
        // covered.
        if (this._distribution && monitoring.cloudFrontAlarmDeferred) {
          if (Token.isUnresolved(hostingStack.account)) {
            // Off-region + unresolved account (a legitimate single-synth,
            // multi-account pipeline shape): we CANNOT build the us-east-1
            // support stack, because a cross-region stack pairing needs a
            // concrete account at synth. CDK bakes real ARNs into the
            // cross-region export machinery, and Aws.ACCOUNT_ID / Ref is
            // rejected. See docs/DECISIONS.md D-016.
            //
            // Rather than hard-throw (which forced monitoring.enabled:false
            // and took down the working regional SSR/image/DLQ alarms too),
            // skip ONLY the CloudFront alarm and warn loudly. A visible
            // synth warning is not the silent-alarm failure #481 is about.
            // The operator is told, in build output, exactly what is missing
            // and how to get it (set env: { account, region }).
            Annotations.of(this).addWarningV2(
              '@aws-blocks/hosting:CloudFrontAlarmSkippedNoAccount',
              `Skipping the off-region CloudFront 5xx alarm: the stack's ` +
                `region is '${region}' but its account is unresolved, and a ` +
                `us-east-1 support stack cannot be synthesized without a ` +
                `concrete account. All other hosting alarms (SSR, image, ` +
                `DLQ) are unaffected. Set env: { account, region } on the ` +
                `stack to enable CloudFront 5xx coverage (issue #481).`,
            );
          } else {
            // Belt-and-suspenders: only reachable for a Hosting construct with no enclosing App/Stage
            // (CDK's App extends Stage, so Stage.of(this) resolves in normal use). Fail loud rather
            // than synthesize a mis-scoped us-east-1 support stack.
            const stage = Stage.of(this);
            if (!stage) {
              throw new HostingError('MonitoringStageRequiredError', {
                message:
                  `Cannot create the us-east-1 CloudFront monitoring stack: no ` +
                  `enclosing App/Stage was found for this construct.`,
                resolution:
                  `Instantiate hosting within a CDK App (or Stage).`,
              });
            }
            // The us-east-1 CloudFront alarm must reference the regional
            // distribution's id; CDK bridges that with its standard
            // cross-region export reader/writer custom resources (added to
            // both stacks automatically). The support stack applies the same
            // subscriptions to its own us-east-1 topic. Its id folds in the
            // construct's node addr so two Hosting constructs in one stage
            // don't collide.
            const cfMonitoring = new UsEast1MonitoringStack(
              stage,
              `${hostingStack.stackName}-CfMonitoring-${this.node.addr.slice(0, 8)}`,
              {
                env: { account: hostingStack.account, region: 'us-east-1' },
                distributionId: this._distribution.distributionId,
                subscriptions,
              },
            );
            alarmTopics.push(cfMonitoring.topic);
            alarms.push(cfMonitoring.alarm);
          }
        }

        this.monitoring = { alarms, alarmTopics };
      }

      // ---- 9a. OPEN_NEXT_ORIGIN env var for URL construction ----
      // OpenNext's origin resolver (pattern-env) reads OPEN_NEXT_ORIGIN as a JSON
      // map of origin names → {host, protocol, port}. Only the primary server
      // function needs this — it enables internal routing to resolve origins for
      // URL construction (avoiding "TypeError: Invalid URL" on path-only rewrites).
      // Image optimization and other secondary compute functions don't need it.
      if (hasCompute) {
        // Identify the primary server function (the one handling SSR routing)
        const primaryComputeName =
          [...this.computeWebFunctions.keys()][0] ??
          (this.computeFunctions.has('default')
            ? 'default'
            : this.computeFunctions.has('server')
              ? 'server'
              : [...this.computeFunctions.keys()].find((k) => k !== 'image-optimization' && k !== 'middleware'));

        if (primaryComputeName) {
          const primaryFn =
            this.computeWebFunctions.get(primaryComputeName) ?? this.computeFunctions.get(primaryComputeName);
          if (primaryFn instanceof LambdaFunction || primaryFn instanceof WebFunctionConstruct) {
            // Build origin map with OTHER functions' URLs (not self → avoids cycle)
            const originEntries: string[] = [];
            for (const [urlName, fnUrl] of this.computeFunctionUrls.entries()) {
              if (urlName === primaryComputeName) continue;
              const originKey = urlName === 'image-optimization' ? 'imageOptimizer' : urlName;
              const host = Fn.select(2, Fn.split('/', fnUrl.url));
              originEntries.push(Fn.join('', [`"${originKey}":{"host":"`, host, `","protocol":"https","port":443}`]));
            }

            if (originEntries.length > 0) {
              const openNextOriginJson = Fn.join('', ['{', Fn.join(',', originEntries), '}']);
              primaryFn.addEnvironment('OPEN_NEXT_ORIGIN', openNextOriginJson);
            } else {
              primaryFn.addEnvironment('OPEN_NEXT_ORIGIN', '{}');
            }
          }
        }
      }

      // ---- 9b. KMS decrypt for CloudFront OAC ----
      // No explicit key-policy statement is added here: `S3BucketOrigin.withOriginAccessControl`
      // (cdn_construct.ts) grants `kms:Decrypt` on the bucket's key — including a BYO
      // `storage.encryptionKey`, which is set as the bucket's encryption key — conditioned on
      // `AWS:SourceArn` matching this account's CloudFront distributions.

      // ---- 10. DNS records ----
      if (f.domain && dnsConstructs.length > 0) {
        for (const dns of dnsConstructs) {
          dns.createDnsRecords(cdn.distribution);
        }
      }
    } else {
      // ---- Front door: non-CloudFront (dispatch by kind) ----
      // Storage + compute are already built above (front-door-agnostic). Every
      // door is a free-form door: one `build`, called once here with the
      // DoorInput (plus a built-in's internal extras). Static assets are uploaded
      // to `builds/<buildId>/` by the shared section 12 below and read by each
      // door's asset-proxy. Skew-pin is a CloudFront-edge feature, so the plan
      // these doors render carries it off.
      // `'none'` (bare string) → serve S3 directly; otherwise an object door.
      const isNone = resolved.kind === 'none';
      const fd = typeof props.frontDoor === 'object' && props.frontDoor !== null ? props.frontDoor : undefined;
      const serverName = this.computeFunctions.has('default')
        ? 'default'
        : this.computeFunctions.has('server')
          ? 'server'
          : undefined;
      const hasImageOrigin = this.computeFunctions.has('image-optimization');
      const computeFunctions = this.computeFunctions as Map<
        string,
        import('aws-cdk-lib/aws-lambda').IFunction
      >;
      // Same-origin backend routing: a single `'*'` origin (single-compute) from
      // the backend API URL the Blocks layer threads in. A future multi-compute
      // caller passes several named-namespace origins here; the built-in doors
      // already loop over `plan.backend.origins`. Omitting it = cross-origin API.
      const backendApiUrl = isNone ? undefined : props.backendApi?.url;
      const backendApiPaths = props.backendApi?.paths;
      const backendOrigins = backendApiUrl
        ? [{ namespace: '*', ingress: { kind: 'url' as const, url: backendApiUrl } }]
        : undefined;
      const plan = buildHostingPlan({
        manifest,
        buildId,
        hasServer: Boolean(serverName),
        hasImage: hasImageOrigin,
        skewEnabled: false,
        wwwRedirect: f.domain?.wwwRedirect,
        backendOrigins,
      });
      const common = {
        plan,
        bucket: this.bucket,
        computeFunctions,
        serverComputeName: serverName,
        imageComputeName: hasImageOrigin ? 'image-optimization' : undefined,
      };
      const domainNames = f.domain
        ? Array.isArray(f.domain.domainName)
          ? f.domain.domainName
          : [f.domain.domainName]
        : undefined;
      let built: FrontDoorResult & { originHandle: OriginHandle };
      let service: string;
      if (isNone) {
        // No front door — serve the origin directly via S3 website hosting. The
        // door refuses an app with a server (a website bucket can't run one).
        // ('none' maps to the internal `s3-website` door.)
        this.doorInput = this.assembleDoorInput(plan, manifest, props, resolved, serverName);
        built = buildFrontDoor(
          this,
          s3WebsiteDoor,
          {
            ...this.doorInput,
            plan,
            // The website bucket gets the same cache tiers and upload sizing as
            // the private uploads below (which `'none'` doesn't need: section 12
            // is skipped for a door that serves its own public bucket).
            upload: {
              immutablePaths: manifest.staticAssets.immutablePaths,
              cacheControl: manifest.staticAssets.cacheControl,
              deploymentSizing: {
                memoryLimit: props.storage?.deployment?.memoryLimit ?? 1024,
                ephemeralStorageSize: Size.mebibytes(props.storage?.deployment?.ephemeralStorageMiB ?? 1024),
              },
            },
          },
          { wiringCheck: false },
        ).result;
        service = s3WebsiteDoor.service;
      } else if (fd?.kind === 'alb' || fd?.kind === 'stackedRouter') {
        this.doorInput = this.assembleDoorInput(plan, manifest, props, resolved, serverName, backendApiUrl, backendApiPaths);
        const certificate = fd.certificate;
        built = buildFrontDoor(
          this,
          albDoor,
          {
            ...this.doorInput,
            alb: {
              ...common,
              vpc: fd.vpc,
              internal: fd.internal,
              certificate,
              restrictToCloudFront: stackedRouter,
              errorPages: this.doorInput.app.errorPages,
              // Custom domain: names from `features.domain`; the regional cert is
              // the door's `certificate`, else `domain.certificate`, else
              // DNS-validated against the hosted zone by the construct.
              domain:
                f.domain && domainNames
                  ? {
                      names: domainNames,
                      hostedZone: f.domain.hostedZone,
                      hostedZoneId: f.domain.hostedZoneId,
                      certificate: certificate ?? f.domain.certificate,
                    }
                  : undefined,
              // Native ALB features, from the ALB door's settings
              // (`frontDoor.features`, plus the deprecated top-level aliases).
              // Logging is off unless set (and not `enabled: false`); monitoring is
              // on unless `enabled: false`, the `HostingProps.monitoring` default
              // the CloudFront door uses too.
              accessLogging: f.logging !== undefined && f.logging.enabled !== false,
              waf: f.waf,
              monitoring: f.monitoring?.enabled ?? true,
            },
          },
          { wiringCheck: false },
        ).result;
        service = albDoor.service;
        // The load balancer's own DNS name (not the custom domain the origin
        // handle names when it has one: an alias record points the domain here).
        const alb = this.node.findAll().find((c): c is AlbConstruct => c instanceof AlbConstruct);
        this.loadBalancerDnsName = alb?.loadBalancer.loadBalancerDnsName;
      } else if (fd?.kind === 'apiGateway') {
        // API Gateway owns routing: a route per origin (asset-proxy → private S3,
        // SSR/image Lambdas) plus native same-origin backend proxy. `api` picks
        // the HTTP API v2 (default) vs a REST API (lambda:InvokeFunction — no
        // Function-URL body-hash issue).
        this.doorInput = this.assembleDoorInput(plan, manifest, props, resolved, serverName, backendApiUrl, backendApiPaths);
        built = buildFrontDoor(
          this,
          apiGatewayDoor,
          {
            ...this.doorInput,
            apiType: fd.api ?? 'http',
            apiGateway: {
              ...common,
              errorPages: this.doorInput.app.errorPages,
              computeRoutes: directComputeRoutes(manifest, this.computeFunctions, serverName),
              ...(props.skipImageOptimization ? { imageFallback: { hosts: imageRemoteHosts(manifest) } } : {}),
              // Custom domain: names come from `domain`; the regional cert is the
              // door's `certificate` (BYO, stack-region) or `domain.certificate`,
              // else DNS-validated against the hosted zone by the construct.
              domain:
                f.domain && domainNames
                  ? {
                      names: domainNames,
                      hostedZone: f.domain.hostedZone,
                      hostedZoneId: f.domain.hostedZoneId,
                      certificate: fd.certificate ?? f.domain.certificate,
                    }
                  : undefined,
            },
          },
          { wiringCheck: false },
        ).result;
        service = apiGatewayDoor.service;
      } else if (fd?.kind === 'custom') {
        // BYO custom door: AWS Blocks hands it the DoorInput and calls `build`
        // once. Its `url` is required; its routing (assets reachable, API paths
        // wired) is checked from what the `cf.*` helpers recorded, unless the
        // app turned that off. Features are the door's to apply — not checked.
        this.doorInput = this.assembleDoorInput(plan, manifest, props, resolved, serverName, backendApiUrl, backendApiPaths);
        built = buildFrontDoor(this, fd.door, this.doorInput, { wiringCheck: fd.wiringCheck }).result;
        service = fd.door.service;
      } else {
        throw new HostingError('UnsupportedFrontDoorError', {
          message: `Unknown front door '${JSON.stringify(props.frontDoor)}'.`,
          resolution:
            "Use 'cloudfront' (default), 'none' (S3 website), { kind: 'alb' }, { kind: 'apiGateway' }, or { kind: 'custom', door }.",
        });
      }
      // A regional door serves static files through a Lambda asset proxy:
      // report the files too large for its response limit. Behind the stacked
      // door's edge, the router is reached only for what the edge doesn't serve
      // from S3 (the edge door reports that check itself).
      if ((fd?.kind === 'alb' || fd?.kind === 'apiGateway') && !stackedRouter) {
        warnOversizedProxyAssets(this, {
          door: fd.kind === 'alb' ? 'ALB' : 'API Gateway',
          ...(fd.kind === 'alb'
            ? { limitBytes: ALB_LAMBDA_RESPONSE_LIMIT, limitLabel: '1 MB' }
            : { limitBytes: LAMBDA_SYNC_RESPONSE_LIMIT, limitLabel: "6 MB (Lambda's response limit, under API Gateway's 10 MB)" }),
          staticDir: manifest.staticAssets.directory,
          urlPrefix: plan.policies.basePath ?? '',
        });
      }
      // A door served over plain HTTP with an API: sign-in, cookies and every
      // RPC travel in cleartext between the browser and the door.
      // (The stacked door's router isn't the public address: the core warns about its hop.)
      // The S3 website's URL is a token at synth, so its handle's protocol says it.
      const plainHttp = built.url.startsWith('http://') || built.originHandle.protocol === 'http';
      if (plainHttp && props.backendApi && !stackedRouter) {
        Annotations.of(this).addWarningV2(
          '@aws-blocks/hosting:PlainHttpFrontDoor',
          `The '${resolved.kind}' front door serves the app over plain HTTP (${isNone ? 'an S3 website has no TLS' : 'no certificate'}), ` +
            'so the pages — and, through a same-origin API, sign-in, session cookies and every RPC — travel unencrypted. ' +
            (isNone
              ? ''
              : 'AuthBasic drops `Secure` from its session cookie behind such a door; AuthCognito and AuthOIDC keep it, ' +
                "so the browser discards their session cookie and sign-in doesn't persist. ") +
            (isNone
              ? 'Use the CloudFront door for HTTPS.'
              : "Give the ALB door a `certificate` and `features.domain`, or use the CloudFront or stacked door."),
        );
      }
      this.distributionUrl = built.url;
      this.frontDoor = { service, url: built.url, originHandle: built.originHandle };
      onUpload = built.onUpload;
      cutover = built.cutover ?? [];
      // The S3-website door serves from its own public bucket; expose it so the
      // Blocks wrapper can publish config.json to the same (cross-origin) origin.
      if (built.publicBucket) this.websiteBucket = built.publicBucket;
    }

    // ---- 11. Error page deployment (SSR only) ----
    // Every BucketDeployment that writes to the new build's
    // `builds/${buildId}/` prefix is collected here. After they are all
    // declared, the CloudFront build-id functions are made to depend on
    // them (see `cdn.addBuildAssetDependency` at the end of this method) so
    // the buildId cutover never races ahead of the asset uploads.
    const buildAssetDeployments: BucketDeployment[] = [];
    if (hasCompute && cdn) {
      buildAssetDeployments.push(
        new BucketDeployment(this, 'ErrorPageDeployment', {
          sources: [Source.data(ERROR_PAGE_KEY, cdn.errorPageHtml)],
          destinationBucket: this.bucket,
          destinationKeyPrefix: `builds/${buildId}/`,
          prune: false,
        }),
      );
    }

    // ---- 11-bis. Default 404 page (multi-page static only) ----
    // For multi-page static sites (spaFallback === false) that shipped no
    // 404.html and got no user-supplied notFound page. Deploy it so the page
    // every door serves for a miss resolves from S3: the CloudFront door's
    // wired 403/404 → /builds/<id>/_not_found.html responses (decided by the
    // CDN construct), and on every other door the asset proxy's (or a
    // bring-your-own door's) `app.errorPages.notFound`.
    const defaultNotFoundPageHtml = cdn
      ? cdn.defaultNotFoundPageHtml
      : this.servesDefaultNotFoundPage(manifest, props)
        ? DEFAULT_NOT_FOUND_PAGE_HTML
        : undefined;
    if (defaultNotFoundPageHtml) {
      // A build upload like any other: the cutover waits for it, so a miss
      // never reaches the new build before its 404 page does.
      buildAssetDeployments.push(
        new BucketDeployment(this, 'DefaultNotFoundPageDeployment', {
          sources: [Source.data(NOT_FOUND_PAGE_KEY, defaultNotFoundPageHtml)],
          destinationBucket: this.bucket,
          destinationKeyPrefix: `builds/${buildId}/`,
          prune: false,
        }),
      );
    }

    // ---- 11a. Custom error pages ----
    if (props.errorPages?.notFound) {
      if (!fs.existsSync(props.errorPages.notFound)) {
        throw new HostingError('CustomErrorPageNotFoundError', {
          message: `Custom 404 error page not found at path: ${props.errorPages.notFound}`,
          resolution: 'Ensure the notFound path points to an existing HTML file relative to your project root.',
        });
      }
      const notFoundContent = fs.readFileSync(props.errorPages.notFound, 'utf-8');
      if (notFoundContent.length > 50 * 1024) {
        throw new HostingError('ErrorPageTooLargeError', {
          message: `Custom error page at ${props.errorPages.notFound} is ${Math.round(notFoundContent.length / 1024)}KB. Maximum is 50KB.`,
          resolution: 'Reduce the size of your custom error page HTML file.',
        });
      }
      if (
        !notFoundContent.trim().toLowerCase().includes('<html') &&
        !notFoundContent.trim().toLowerCase().includes('<!doctype')
      ) {
        throw new HostingError('InvalidErrorPageContentError', {
          message: `Custom error page at ${props.errorPages.notFound} does not appear to be valid HTML.`,
          resolution: 'Ensure the file contains valid HTML (should include <html> or <!DOCTYPE> tag).',
        });
      }
      buildAssetDeployments.push(
        new BucketDeployment(this, 'Custom404Deployment', {
          sources: [Source.data('404.html', notFoundContent)],
          destinationBucket: this.bucket,
          destinationKeyPrefix: `builds/${buildId}/`,
          prune: false,
        }),
      );
    }
    if (props.errorPages?.serverError) {
      if (!fs.existsSync(props.errorPages.serverError)) {
        throw new HostingError('CustomErrorPageNotFoundError', {
          message: `Custom 500 error page not found at path: ${props.errorPages.serverError}`,
          resolution: 'Ensure the serverError path points to an existing HTML file relative to your project root.',
        });
      }
      const serverErrorContent = fs.readFileSync(props.errorPages.serverError, 'utf-8');
      if (serverErrorContent.length > 50 * 1024) {
        throw new HostingError('ErrorPageTooLargeError', {
          message: `Custom error page at ${props.errorPages.serverError} is ${Math.round(serverErrorContent.length / 1024)}KB. Maximum is 50KB.`,
          resolution: 'Reduce the size of your custom error page HTML file.',
        });
      }
      if (
        !serverErrorContent.trim().toLowerCase().includes('<html') &&
        !serverErrorContent.trim().toLowerCase().includes('<!doctype')
      ) {
        throw new HostingError('InvalidErrorPageContentError', {
          message: `Custom error page at ${props.errorPages.serverError} does not appear to be valid HTML.`,
          resolution: 'Ensure the file contains valid HTML (should include <html> or <!DOCTYPE> tag).',
        });
      }
      buildAssetDeployments.push(
        new BucketDeployment(this, 'Custom500Deployment', {
          sources: [Source.data('500.html', serverErrorContent)],
          destinationBucket: this.bucket,
          destinationKeyPrefix: `builds/${buildId}/`,
          prune: false,
        }),
      );
    }

    // ---- 11b. Build cache bucket ----
    if (props.buildCache?.enabled) {
      if (props.buildCache.bucket) {
        this.buildCacheBucket = props.buildCache.bucket as Bucket;
      } else {
        this.buildCacheBucket = new Bucket(this, 'BuildCacheBucket', {
          removalPolicy: RemovalPolicy.DESTROY,
          autoDeleteObjects: true,
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          enforceSSL: true,
          lifecycleRules: [{ expiration: Duration.days(30) }],
        });
      }

      new CfnOutput(this, 'BuildCacheBucketName', {
        value: this.buildCacheBucket.bucketName,
        description: 'S3 bucket for framework build cache. Sync .next/cache (or equivalent) in CI.',
      });

      // Set env var on all compute functions so they know the bucket name
      for (const [, fn] of this.envTargets()) {
        fn.addEnvironment('HOSTING_BUILD_CACHE_BUCKET', this.buildCacheBucket.bucketName);
      }
    }

    // ---- 12. Atomic Deployment (static assets) ----
    // Atomicity: every object below is written under a brand-new, immutable
    // `builds/${buildId}/` prefix that was never requested before, so there
    // is nothing stale to invalidate. The CloudFront build-id functions are
    // gated on these uploads (`cdn.addBuildAssetDependency`, end of method)
    // so the distribution only starts routing at the new buildId AFTER the
    // assets land - closing the window where new/cookieless visitors would
    // otherwise hit 403 Access Denied on the not-yet-uploaded prefix.
    //
    // This is also why these deployments deliberately carry NO
    // `distribution` / `distributionPaths: ['/*']` invalidation: with
    // immutable build-id prefixes a `/*` invalidation is useless (the new
    // prefix was never cached) AND it would force the uploads to run AFTER
    // the distribution update, which is the exact ordering that re-opens
    // the 403 window.
    //
    // Cache-Control split (3 tiers):
    //
    //   1. Hashed assets (`immutablePaths`): `max-age=31536000, immutable`
    //   2. HTML files: `no-cache, no-store, must-revalidate` — browsers
    //      must always revalidate so new deploys propagate immediately.
    //   3. Other mutable assets (images, JSON, etc.):
    //      `s-maxage=31536000, max-age=0, must-revalidate` — CloudFront
    //      edge caches for 1y. Each deploy writes them under a fresh
    //      `builds/<id>/` prefix (the path is part of the cache key), so the
    //      new objects are cold-fetched on first request with no
    //      invalidation needed; browsers always revalidate.
    //
    // Font MIME pass (12b below): aws s3 sync (driver inside
    // BucketDeployment) infers Content-Type via Python's mimetypes which
    // lacks `font/woff*` on the Lambda runtime — fonts ship as
    // `binary/octet-stream` and browsers reject them under CORS. We
    // re-deploy *only* font extensions with `contentType` set explicitly.
    //
    // Source-asset reuse: every BucketDeployment below uses the SAME
    // `Source.asset(directory)` instance. CDK staging ZIPs the directory
    // ONCE (asset hash dedup), then references the same staged asset
    // across every deployment. Without reuse, each deployment re-stages
    // the directory — a 100 MB `dist/` × 7 deployments = 700 MB of
    // transient asset uploads + Lambda asset hashes on every cdk synth.
    // A door that serves its own public bucket (`'none'`: the S3 website) has
    // published the build there; nothing reads the private copy.
    if (!this.websiteBucket) {
      const immutablePaths = manifest.staticAssets.immutablePaths;
      const noCachePaths = manifest.staticAssets.noCachePaths;
      const mutableCacheControl =
        manifest.staticAssets.cacheControl ?? 'public, s-maxage=31536000, max-age=0, must-revalidate';
      const htmlCacheControl = 'no-cache, no-store, must-revalidate';
      const htmlGlobs = ['*.html', '**/*.html'];
      const staticSource = Source.asset(manifest.staticAssets.directory);
      // Track the asset deployments so the per-extension font Content-
      // Type deployments can declare an explicit `addDependency` —
      // without this, CDK is free to reorder them and a font deployment
      // that runs BEFORE the matching asset deployment is silently
      // overwritten with `binary/octet-stream` from the next pass. We
      // observed this on a live deploy where the font deployment ran 1
      // minute before the asset deployment that overwrote it.
      const assetDeployments: BucketDeployment[] = [];

      // Sizing for the asset-upload Lambda (CDK's BucketDeployment custom
      // resource). CDK defaults to 128 MB memory + 512 MiB /tmp, which a large
      // static site overruns — the deploy then fails opaquely in CloudFormation
      // (OOM / "no space left on device") with no hint it was a sizing issue.
      // Raise the defaults to 1024/1024; allow an override for extreme builds.
      const deploymentSizing = {
        memoryLimit: props.storage?.deployment?.memoryLimit ?? 1024,
        ephemeralStorageSize: Size.mebibytes(props.storage?.deployment?.ephemeralStorageMiB ?? 1024),
      };

      // Deploy no-cache paths (e.g. config.json) — always revalidate.
      if (noCachePaths && noCachePaths.length > 0) {
        assetDeployments.push(
          new BucketDeployment(this, 'AssetDeploymentNoCache', {
            sources: [staticSource],
            destinationBucket: this.bucket,
            destinationKeyPrefix: `builds/${buildId}/`,
            exclude: ['*'],
            include: noCachePaths,
            cacheControl: [CacheControl.fromString(htmlCacheControl)],
            prune: false,
            ...deploymentSizing,
          }),
        );
      }

      if (immutablePaths && immutablePaths.length > 0) {
        assetDeployments.push(
          new BucketDeployment(this, 'AssetDeploymentImmutable', {
            sources: [staticSource],
            destinationBucket: this.bucket,
            destinationKeyPrefix: `builds/${buildId}/`,
            exclude: ['*'],
            include: immutablePaths,
            cacheControl: [CacheControl.fromString('public, max-age=31536000, immutable')],
            prune: false,
            ...deploymentSizing,
          }),
        );
        assetDeployments.push(
          new BucketDeployment(this, 'AssetDeploymentHtml', {
            sources: [staticSource],
            destinationBucket: this.bucket,
            destinationKeyPrefix: `builds/${buildId}/`,
            exclude: ['*'],
            include: htmlGlobs,
            cacheControl: [CacheControl.fromString(htmlCacheControl)],
            prune: false,
            ...deploymentSizing,
          }),
        );
        assetDeployments.push(
          new BucketDeployment(this, 'AssetDeploymentMutable', {
            sources: [staticSource],
            destinationBucket: this.bucket,
            destinationKeyPrefix: `builds/${buildId}/`,
            exclude: [...immutablePaths, ...htmlGlobs, ...(noCachePaths ?? [])],
            cacheControl: [CacheControl.fromString(mutableCacheControl)],
            prune: false,
            ...deploymentSizing,
          }),
        );
      } else {
        assetDeployments.push(
          new BucketDeployment(this, 'AssetDeploymentHtml', {
            sources: [staticSource],
            destinationBucket: this.bucket,
            destinationKeyPrefix: `builds/${buildId}/`,
            exclude: ['*'],
            include: htmlGlobs,
            cacheControl: [CacheControl.fromString(htmlCacheControl)],
            prune: false,
            ...deploymentSizing,
          }),
        );
        assetDeployments.push(
          new BucketDeployment(this, 'AssetDeploymentOther', {
            sources: [staticSource],
            destinationBucket: this.bucket,
            destinationKeyPrefix: `builds/${buildId}/`,
            exclude: [...htmlGlobs, ...(noCachePaths ?? [])],
            cacheControl: [CacheControl.fromString(mutableCacheControl)],
            prune: false,
            ...deploymentSizing,
          }),
        );
      }
      buildAssetDeployments.push(...assetDeployments);

      // ---- 12b. Font Content-Type pass ----
      // S3's `binary/octet-stream` default for font extensions makes
      // browsers reject fonts under CORS. We re-deploy *only* font
      // files with `contentType` set explicitly so the right MIME wires
      // through to the viewer. One BucketDeployment per extension —
      // each is a CDK custom resource. Failure here would leave fonts
      // with the wrong Content-Type, but the default monitoring
      // construct (P3.1, opt-in) alarms on Lambda errors so silent
      // failures surface in CloudWatch.
      //
      // We reuse the same `staticSource` Source.asset declared above —
      // CDK dedups the staged asset zip across all BucketDeployments
      // via content hash, so the directory is staged exactly once even
      // with N font extensions present.
      //
      // Cache-Control: this pass re-uploads the font objects (a
      // BucketDeployment always rewrites content + metadata), so it would
      // CLOBBER whatever Cache-Control the earlier asset deployments set —
      // leaving hashed fonts under `immutablePaths` with NO directive at
      // all (browser heuristic caching). We can't perfectly re-tier per
      // file: a single BucketDeployment applies one Cache-Control to every
      // match, and its include globs are additive (OR), so "woff2 files
      // that are ALSO under an immutable path" isn't expressible.
      //
      // So we set the MUTABLE tier here, which is the safe universal
      // choice:
      //   - non-hashed fonts (`public/fonts/…`): mutable is exactly right
      //     (they must stay bustable across deploys).
      //   - hashed fonts (`_next/static/media/…`): CloudFront still edge-
      //     caches for 1y via `s-maxage`; the browser just revalidates
      //     (cheap 304). Strictly better than the no-header state this
      //     pass previously left them in.
      const FONT_TYPES: Array<[string, string]> = [
        ['.woff2', 'font/woff2'],
        ['.woff', 'font/woff'],
        ['.ttf', 'font/ttf'],
        ['.otf', 'font/otf'],
        ['.eot', 'application/vnd.ms-fontobject'],
      ];
      const fontExtensionsPresent = detectFontExtensions(
        manifest.staticAssets.directory,
        FONT_TYPES.map(([ext]) => ext),
      );
      for (const [ext, mime] of FONT_TYPES) {
        if (!fontExtensionsPresent.has(ext)) continue;
        const fontDeployment = new BucketDeployment(this, `FontTypeDeployment${ext.replace('.', '')}`, {
          sources: [staticSource],
          destinationBucket: this.bucket,
          destinationKeyPrefix: `builds/${buildId}/`,
          exclude: ['*'],
          include: [`*${ext}`],
          contentType: mime,
          cacheControl: [CacheControl.fromString(mutableCacheControl)],
          prune: false,
          ...deploymentSizing,
        });
        // Force ordering: the font deployment must run AFTER the asset
        // deployments that ship the same files with the wrong default
        // Content-Type. Without this dependency, CDK is free to schedule
        // the font deployment first; the subsequent asset deployment
        // then re-uploads the font with `binary/octet-stream` and
        // silently undoes the fix.
        for (const dep of assetDeployments) {
          fontDeployment.node.addDependency(dep);
        }
        buildAssetDeployments.push(fontDeployment);
      }
    }

    // ---- 12c. Gate the build-id cutover on the asset uploads ----
    // Make the CloudFront build-id functions (viewer-request, and the
    // Next.js assetPrefix strip function) depend on every BucketDeployment
    // that writes the new build's `builds/${buildId}/` prefix. CloudFormation
    // therefore uploads all assets FIRST and only then publishes the
    // functions / updates the distribution to route at the new buildId.
    // Without this, the buildId could propagate globally before the assets
    // landed, 403-ing new/cookieless visitors for the deploy window.
    if (cdn) {
      for (const dep of buildAssetDeployments) {
        cdn.addBuildAssetDependency(dep);
      }
    }
    // Every other door names its own cutover (`FrontDoorResult.cutover`): the
    // asset proxies' `ASSET_KEY_PREFIX: builds/<buildId>` environment is the
    // ALB and API Gateway doors' switch to the new build. Each waits for every
    // upload here, and — recorded with the post-upload constructs — for the
    // uploads declared later (`addBuildAssetDependency`, e.g. the resolved
    // runtime config), so the previous build serves until the new one is whole.
    for (const c of cutover) {
      for (const dep of buildAssetDeployments) c.node.addDependency(dep);
      this.postUploadConstructs.push(c);
    }

    // ---- 12d. The front door's post-upload hook ----
    // Every asset upload for this build is declared now, so a door can declare
    // resources that must run after them (e.g. a CloudFront invalidation via
    // `cf.invalidate`). Like the door itself, it only declares resources.
    // What it declares is recorded, so an upload declared after this construct
    // (the `@aws-blocks/core` `Hosting` uploads the resolved runtime config
    // later, via `addBuildAssetDependency`) is ordered before it too.
    if (onUpload) {
      const uploads: readonly BucketDeployment[] = [...buildAssetDeployments];
      registerUploads(uploads, buildId);
      const root = this.node.root;
      const before = new Set<IConstruct>(root.node.findAll());
      onUpload({ uploads, buildId });
      for (const c of root.node.findAll()) {
        // The top-most constructs it declared (their parent existed before),
        // except a stack-level singleton (e.g. a shared custom-resource
        // provider) — that may also serve resources the later upload waits on.
        const parent = c.node.scope;
        if (before.has(c) || !parent || !before.has(parent) || Stack.isStack(parent)) continue;
        this.postUploadConstructs.push(c);
      }
    }

    // ---- CloudFormation resource-count guard ----
    // Retain the CDKBucketDeployment custom resources so they are skipped on
    // stack DELETE. A BucketDeployment CR runs a delete-time handler (object
    // cleanup and, when configured, a CloudFront invalidation — aws-cdk#15891 /
    // aws-cdk#23708); if that handler fails (e.g. the distribution is being
    // deleted concurrently, or the role/bucket is already gone) the custom
    // resource delete wedges the whole stack in DELETE_FAILED, which orphans the
    // CloudFront distribution. Retaining the CR removes it from the teardown
    // path entirely, so the stack (and its distribution) can delete cleanly.
    // Safe because the bucket's own autoDeleteObjects / the sandbox teardown
    // empties the objects — the CR isn't needed to clean them up. This was
    // observed leaking distributions on the high-volume Amplify SSR-adapter e2e
    // (deployment-type=standalone), which consumes this construct.
    //
    // We deliberately do NOT retain the bucket's Custom::S3AutoDeleteObjects CR,
    // even though it's also a delete-time handler on the teardown path: it only
    // empties its own bucket (an S3-only op, no CloudFront invalidation or
    // cross-service call), so it's far less wedge-prone, and it's the mechanism
    // that actually removes the objects. Retaining it would instead leave every
    // bucket non-empty and blocking. Only the BucketDeployment CR — whose
    // delete-time invalidation is the wedge — is retained.
    for (const child of this.node.findAll()) {
      if (CfnResource.isCfnResource(child) && child.cfnResourceType === 'Custom::CDKBucketDeployment') {
        child.applyRemovalPolicy(RemovalPolicy.RETAIN);
      }
    }

    // A stack can hold at most 500 resources (a true hard limit — not
    // adjustable). The hosting construct emits many resources, and they
    // multiply with routes/behaviors/policies/asset-deployments, so a large
    // app can approach the ceiling and then fail opaquely at deploy. Emit a
    // synth-time warning as the stack nears the limit so the operator can
    // split the stack BEFORE CloudFormation rejects it. This warns (never
    // fails) — CDK itself errors at 500, and a legitimate stack just under
    // the limit must still deploy.
    this.node.addValidation({
      validate: (): string[] => {
        const resourceCount = Stack.of(this)
          .node.findAll()
          .filter((c) => CfnResource.isCfnResource(c)).length;
        if (resourceCount >= CFN_RESOURCE_WARNING_THRESHOLD) {
          Annotations.of(this).addWarningV2(
            '@aws-blocks/hosting:CfnResourceCount',
            `This stack synthesizes ~${resourceCount} CloudFormation resources, ` +
              `approaching the hard limit of ${CFN_MAX_RESOURCES_PER_STACK} per ` +
              `stack. Large hosting deploys (many routes, header rules, or asset ` +
              `tiers) can hit this and fail at deploy time. Consider splitting ` +
              `the backend and hosting into separate stacks, or reducing ` +
              `per-pattern routes/headers.`,
          );
        }
        return [];
      },
    });
  }

  /**
   * Every regional compute that takes environment variables and IAM grants:
   * Lambda functions (Lambda\@Edge has no env vars — skipped) plus Web
   * Functions.
   */
  private envTargets(): Array<[string, LambdaFunction | WebFunctionConstruct]> {
    const targets: Array<[string, LambdaFunction | WebFunctionConstruct]> = [];
    for (const [name, fn] of this.computeFunctions) {
      if (fn instanceof LambdaFunction) targets.push([name, fn]);
    }
    for (const entry of this.computeWebFunctions) targets.push(entry);
    return targets;
  }

  /**
   * Lambda-only knobs have no Web Function equivalent — warn instead of
   * silently ignoring them (an app switching `compute.type` often keeps its
   * existing `memorySize`).
   */
  private warnInapplicableWebFunctionOptions(compute: NonNullable<HostingConstructProps['compute']>): void {
    const ignored: Array<[keyof typeof compute, string]> = [
      ['memorySize', 'each Web Function environment has a fixed 2 GB'],
      ['reservedConcurrency', 'use `webFunction.maxEnvironments` to cap scale'],
      ['provisionedConcurrency', 'Web Functions keep warm headroom automatically'],
      ['warmup', 'Web Functions keep warm headroom automatically'],
    ];
    for (const [key, hint] of ignored) {
      if (compute[key] === undefined) continue;
      Annotations.of(this).addWarningV2(
        `@aws-blocks/hosting:WebFunctionIgnores-${key}`,
        `compute.${key} does not apply to compute.type 'web-function' and is ignored (${hint}).`,
      );
    }
  }

  /**
   * Get the hosting resources for output wiring.
   */
  getResources(): HostingResources {
    // `distribution` is read lazily, so a non-CloudFront deploy can still call
    // this; reading `distribution` on it throws (see the getter).
    const self = this;
    return {
      bucket: this.bucket,
      get distribution(): Distribution {
        return self.distribution;
      },
      distributionUrl: this.distributionUrl,
      buildCacheBucket: this.buildCacheBucket,
    };
  }

  /**
   * Assemble the {@link DoorInput} from the plan, the resources this construct
   * provisioned, and the feature props. Has no effect on the template unless a
   * door reads `origins.server.url` (created on first read).
   */
  /**
   * Whether this deploy serves AWS Blocks' default 404 page
   * (`needsDefaultNotFoundPage`): a multi-page static site with no 404 page of
   * its own. Not behind `'none'`: an S3 website answers a miss from its own
   * error document, in its own bucket.
   */
  private servesDefaultNotFoundPage(manifest: DeployManifest, props: HostingConstructProps): boolean {
    if (this.frontDoorKind === 'none') return false;
    return needsDefaultNotFoundPage(manifest, { userNotFound: !!props.errorPages?.notFound });
  }

  private assembleDoorInput(
    plan: import('../plan/types.js').HostingPlan,
    manifest: DeployManifest,
    props: HostingConstructProps,
    resolved: ResolvedHostingFrontDoor,
    serverName: string | undefined,
    backendApiUrl?: string,
    backendApiPaths?: readonly string[],
  ): DoorInput {
    const serverFn = serverName ? this.computeFunctions.get(serverName) : undefined;
    const imageFn = this.computeFunctions.get('image-optimization');
    const imageUrl = this.computeFunctionUrls.get('image-optimization');
    return buildDoorInput({
      plan,
      bucket: this.bucket,
      staticDir: manifest.staticAssets.directory,
      // Lambda@Edge server functions have no Function URL and are reached
      // through their own behavior, so only a regional server is an origin.
      server:
        serverName && serverFn instanceof LambdaFunction
          ? {
              fn: serverFn,
              url: this.computeFunctionUrls.get(serverName),
              // The truth about the server as built: a Lambda Web Adapter server
              // streams unless the door needs it buffered; a native handler
              // streams as its build declared.
              streaming:
                manifest.compute?.[serverName]?.type === 'http-server'
                  ? this.serverResponse === 'streaming'
                  : manifest.compute?.[serverName]?.streaming !== false,
            }
          : undefined,
      image: imageFn instanceof LambdaFunction && imageUrl ? { fn: imageFn, url: imageUrl } : undefined,
      api: backendApiUrl ? { url: backendApiUrl, paths: backendApiPaths } : undefined,
      domain: resolved.features.domain,
      waf: resolved.features.waf,
      cdnWebAclArn: resolved.cdnWebAclArn,
      logging: resolved.features.logging,
      monitoring: resolved.features.monitoring,
      geoRestriction: resolved.features.geoRestriction,
      errorPages: props.errorPages,
      frameworkErrorPages: frameworkErrorPagesOf(manifest, this.servesDefaultNotFoundPage(manifest, props)),
      skewProtection: resolved.features.skewProtection,
    });
  }
}

/** The door kind and its effective settings, plus the legacy `cdn.webAclArn`. */
type ResolvedHostingFrontDoor = ResolvedFrontDoor & { cdnWebAclArn?: string };

/**
 * Resolve the door's effective settings from `frontDoor.features` and the
 * deprecated top-level props (see `resolveFrontDoorFeatures`). `cdn.webAclArn`
 * stays a separate, lower-precedence alias of `waf.webAclArn` (as it always
 * was): it conflicts only with `frontDoor.features.waf.webAclArn`.
 *
 * @throws HostingError('FrontDoorSettingConflictError') when a setting is set both ways.
 * @throws HostingError('UnsupportedFrontDoorSettingError') when the door kind doesn't implement a setting.
 */
const resolveHostingFrontDoor = (props: HostingConstructProps): ResolvedHostingFrontDoor => {
  const cdn = props.cdn;
  const resolved = resolveFrontDoorFeatures(props.frontDoor, {
    domain: { value: props.domain, prop: 'domain' },
    waf: { value: props.waf, prop: 'waf' },
    logging: { value: props.logging, prop: 'logging' },
    monitoring: { value: props.monitoring, prop: 'monitoring' },
    skewProtection: { value: props.skewProtection, prop: 'skewProtection' },
    priceClass: { value: cdn?.priceClass, prop: 'cdn.priceClass' },
    contentSecurityPolicy: { value: cdn?.contentSecurityPolicy, prop: 'cdn.contentSecurityPolicy' },
    geoRestriction: { value: cdn?.geoRestriction, prop: 'cdn.geoRestriction' },
    ssrDefaultTtl: { value: cdn?.ssrDefaultTtl, prop: 'cdn.ssrDefaultTtl' },
    cacheKeyCookies: { value: cdn?.cacheKeyCookies, prop: 'cdn.cacheKeyCookies' },
    cacheKeyHeaders: { value: cdn?.cacheKeyHeaders, prop: 'cdn.cacheKeyHeaders' },
    responseHeadersPolicy: { value: cdn?.responseHeadersPolicy, prop: 'cdn.responseHeadersPolicy' },
    quotas: { value: cdn?.quotas, prop: 'cdn.quotas' },
  });
  const cdnWebAclArn = cdn?.webAclArn;
  if (cdnWebAclArn !== undefined) {
    const explicit = typeof props.frontDoor === 'object' ? props.frontDoor?.features : undefined;
    const waf: unknown = explicit && 'waf' in explicit ? explicit.waf : undefined;
    const explicitArn =
      waf && typeof waf === 'object' && 'webAclArn' in waf && typeof waf.webAclArn === 'string' ? waf.webAclArn : undefined;
    if (explicitArn !== undefined) {
      throw new HostingError('FrontDoorSettingConflictError', {
        message: '`cdn.webAclArn` and `frontDoor.features.waf.webAclArn` are both set. They are the same setting.',
        resolution: 'Keep `frontDoor.features.waf.webAclArn` and remove `cdn.webAclArn` (deprecated).',
      });
    }
    if (resolved.kind !== 'cloudfront' && resolved.kind !== 'custom') {
      throw new HostingError('UnsupportedFrontDoorSettingError', {
        message: `\`cdn.webAclArn\` is not supported by the '${resolved.kind}' front door.`,
        resolution:
          'Remove `cdn.webAclArn` (a CloudFront web ACL). For a door with a WAF, set `frontDoor.features.waf` instead.',
      });
    }
  }
  return { ...resolved, cdnWebAclArn };
};

/**
 * What a front door can serve, declared once per built-in door and read by
 * every check and default that depends on it, so the doors cannot disagree:
 *
 * - `streaming`: it invokes the server with response streaming, so a
 *   streaming handler (`streamifyResponse`, e.g. the OpenNext server) answers
 *   through it. An ALB Lambda target (also the stacked door's router) and an
 *   API Gateway HTTP API integration invoke synchronously; the CloudFront
 *   door and the API Gateway REST door stream.
 * - `wildcardRoutes`: it routes a wildcard anywhere in a path (`/*.js`), not
 *   only as a whole trailing segment.
 * - `appliesRules`: it applies the app's redirects, header rules and error
 *   pages to every response, not only to those its asset proxy answers.
 * - `forwardedHost`: it sets `x-forwarded-host` from the viewer's `Host`, over
 *   any value the client sent. Behind a door that doesn't, the server is
 *   given `Host` as `x-forwarded-host` instead (see `withDoorEventShim`), so a
 *   server that builds redirects or absolute URLs from it never uses a host
 *   the client chose.
 *
 * A bring-your-own door declares only `streaming`, through `serverResponse`
 * (default `'streaming'`); the rest are its own to wire (and `cf.recordWired`
 * reports what it left out).
 *
 * @internal Framework-only.
 */
export type DoorCapabilities = {
  readonly streaming: boolean;
  readonly wildcardRoutes?: boolean;
  readonly appliesRules?: boolean;
  readonly forwardedHost?: boolean;
};

/**
 * The capabilities of the selected door (see `DoorCapabilities`).
 *
 * @internal Framework-only.
 */
export const doorCapabilitiesFor = (frontDoor: HostingConstructProps['frontDoor']): DoorCapabilities => {
  if (frontDoor === 'none') return { streaming: false, wildcardRoutes: false, appliesRules: false, forwardedHost: false };
  if (typeof frontDoor !== 'object' || frontDoor === null) {
    return { streaming: true, wildcardRoutes: true, appliesRules: true, forwardedHost: true };
  }
  switch (frontDoor.kind) {
    case 'alb':
      return { streaming: albDoor.serverResponse === 'streaming', wildcardRoutes: true, appliesRules: false, forwardedHost: false };
    case 'stackedRouter':
      // The edge in front applies the rules and sets the forwarded host; the ALB under it invokes the server.
      return { streaming: albDoor.serverResponse === 'streaming', wildcardRoutes: true, appliesRules: true, forwardedHost: true };
    case 'apiGateway':
      return { streaming: (frontDoor.api ?? 'http') === 'rest', wildcardRoutes: false, appliesRules: false, forwardedHost: false };
    case 'custom':
      // `door` is validated (with a clear error) by the time the door is built.
      return { streaming: (frontDoor.door?.serverResponse ?? 'streaming') === 'streaming' };
    default:
      return { streaming: true, wildcardRoutes: true, appliesRules: true, forwardedHost: true };
  }
};

/**
 * The routes a regional door sends straight to a compute other than the
 * server and the image function (e.g. a Next.js `runtime: 'edge'` route built
 * as a regional function): the route table lists them as server routes.
 * Lambda@Edge functions are reached only through CloudFront and are skipped.
 *
 * @param manifest the deploy manifest.
 * @param computeFunctions the functions built for the manifest's compute.
 * @param serverName the server compute's name, if any.
 * @returns `{ pattern, computeName }` (basePath-prefixed), most-specific first.
 */
const directComputeRoutes = (
  manifest: DeployManifest,
  computeFunctions: ReadonlyMap<string, unknown>,
  serverName: string | undefined,
): { pattern: string; computeName: string }[] =>
  manifest.routes
    .filter(
      (r) =>
        r.target !== serverName &&
        r.target !== 'image-optimization' &&
        computeFunctions.has(r.target) &&
        manifest.compute[r.target]?.type !== 'edge',
    )
    .map((r) => ({ pattern: prependBasePath(manifest.basePath, r.pattern), computeName: r.target }))
    .sort((a, b) => routeSpecificity(b.pattern) - routeSpecificity(a.pattern));

/**
 * The remote image hosts the app allows its image optimizer to fetch: the
 * manifest's `imageOptimization.domains` and `remotePatterns` hostnames.
 *
 * @param manifest the deploy manifest.
 * @returns the hosts (may carry a `*.` / `**.` wildcard prefix).
 */
const imageRemoteHosts = (manifest: DeployManifest): string[] => [
  ...(manifest.imageOptimization?.domains ?? []),
  ...(manifest.imageOptimization?.remotePatterns ?? []).map((p) => p.hostname),
];


/**
 * How the selected front door invokes the server-rendering compute. Known
 * before the compute is built, so the server answers in a form the door can
 * carry (see `DoorCapabilities.streaming`).
 */
const serverResponseFor = (frontDoor: HostingConstructProps['frontDoor']): 'streaming' | 'buffered' =>
  doorCapabilitiesFor(frontDoor).streaming ? 'streaming' : 'buffered';

/**
 * Fail synth when the server is a streaming Lambda handler (the OpenNext
 * server for Next.js, Nitro with `awsLambda.streaming`) and the door invokes
 * it without streaming. Building the function buffered changes only how it is
 * invoked, not the handler: it still answers with the streaming framing, so
 * behind an ALB target or an API Gateway HTTP API the app deploys and no page
 * answers.
 *
 * @param manifest the deploy manifest.
 * @param capabilities the door's capabilities.
 * @param label the door as the app wrote it, for the message.
 * @throws HostingError('StreamingServerNeedsStreamingDoorError') for a streaming handler behind a door that doesn't stream.
 * @internal Framework-only.
 */
const assertServerReachableByDoor = (manifest: DeployManifest, capabilities: DoorCapabilities, label: string): void => {
  if (capabilities.streaming) return;
  const server = manifest.compute.default ?? manifest.compute.server;
  if (server?.type !== 'handler' || server.streaming !== true) return;
  throw new HostingError('StreamingServerNeedsStreamingDoorError', {
    message:
      `The app's server is a streaming Lambda handler (Next.js through OpenNext, or response streaming turned on in ` +
      `the framework), and the '${label}' front door invokes it without streaming: the app would deploy and every ` +
      'page would fail to answer.',
    resolution:
      "Use the CloudFront door (omit `frontDoor`, or `'cloudfront'`) or `{ kind: 'apiGateway', api: 'rest' }`, " +
      "or turn the framework's response streaming off (Nitro: `awsLambda.streaming: false`).",
  });
};

/**
 * The error pages the framework build shipped (`manifest.errorPages`, e.g. a
 * SPA's `404.html`), as object keys under the build prefix — else, for a
 * multi-page static site that shipped no 404 page, AWS Blocks' default one
 * (`_not_found.html`, see `default_not_found.ts`). `DoorInput` carries them as
 * `app.errorPages` when the app sets none, so every door — the CloudFront and
 * stacked edges, the regional doors' asset proxies, a bring-your-own door
 * through `cf.errorPages` — serves the same page.
 *
 * @param manifest the deploy manifest.
 * @param defaultNotFound whether the deploy serves the default 404 page (`needsDefaultNotFoundPage`).
 * @returns the pages, or `undefined` when there are none.
 */
const frameworkErrorPagesOf = (
  manifest: DeployManifest,
  defaultNotFound = false,
): { notFound?: string; serverError?: string } | undefined => {
  const key = (page: string | undefined) => page?.replace(/^\/+/, '') || undefined;
  const notFound = key(manifest.errorPages?.[404]) ?? (defaultNotFound ? NOT_FOUND_PAGE_KEY : undefined);
  const serverError = key(manifest.errorPages?.[500]);
  if (!notFound && !serverError) return undefined;
  return { ...(notFound ? { notFound } : {}), ...(serverError ? { serverError } : {}) };
};

/**
 * Fit the server to the door it is behind (see `alb_lambda_event.ts`):
 *
 * - Behind the ALB door (also the stacked door's router), the ALB event shim
 *   goes in front of a buffered native Lambda handler: it turns the ALB
 *   Lambda-target event (multi-value headers, top-level method) into the API
 *   Gateway REST shape the handler reads, and its response back into the ALB
 *   shape, so every `Set-Cookie` survives. A Lambda Web Adapter server reads
 *   ALB events natively.
 * - Behind a door that doesn't set `x-forwarded-host` from the viewer's `Host`
 *   (`DoorCapabilities.forwardedHost`: the ALB and API Gateway doors), the
 *   server is given `Host` as `x-forwarded-host`: the ALB shim sets it, a
 *   handler behind API Gateway gets the forwarded-host shim, and a Lambda Web
 *   Adapter server that reads its host from `x-forwarded-host` (adapter-node's
 *   `HOST_HEADER`) reads `host` instead.
 *
 * Only a `handler` server whose module is found in the bundle is wrapped; a
 * bring-your-own door, and the CloudFront door, keep the server as built.
 *
 * @param resource the server compute resource.
 * @param frontDoor the door.
 * @returns the resource to build (with a shim as its handler when wrapped).
 */
const withDoorEventShim = (
  resource: DeployManifest['compute'][string],
  frontDoor: HostingConstructProps['frontDoor'],
): DeployManifest['compute'][string] => {
  if (typeof frontDoor !== 'object' || frontDoor === null) return resource;
  const kind = frontDoor.kind;
  if (kind !== 'alb' && kind !== 'stackedRouter' && kind !== 'apiGateway') return resource;
  const forwardedHostFromHost = doorCapabilitiesFor(frontDoor).forwardedHost === false;
  if (resource.type === 'http-server') {
    if (!forwardedHostFromHost || resource.environment?.HOST_HEADER !== 'x-forwarded-host') return resource;
    return { ...resource, environment: { ...resource.environment, HOST_HEADER: 'host' } };
  }
  if (resource.type !== 'handler') return resource;
  const isAlb = kind !== 'apiGateway';
  if (isAlb && resource.streaming === true) return resource; // fails synth (assertServerReachableByDoor)
  if (!isAlb && !forwardedHostFromHost) return resource;
  const handler = resource.handler ?? 'index.handler';
  const dot = handler.lastIndexOf('.');
  if (dot <= 0) return resource;
  const moduleBase = handler.substring(0, dot);
  const exportName = handler.substring(dot + 1);
  const moduleFile = ['.mjs', '.js', '.cjs']
    .map((ext) => `${moduleBase}${ext}`)
    .find((file) => fs.existsSync(path.join(resource.bundle, file)));
  if (!moduleFile) return resource;
  const [shimFile, shimHandler, code] = isAlb
    ? [ALB_EVENT_SHIM_FILE, ALB_EVENT_SHIM_HANDLER, generateAlbEventShimCode(`./${moduleFile}`, exportName, { forwardedHostFromHost })]
    : [FORWARDED_HOST_SHIM_FILE, FORWARDED_HOST_SHIM_HANDLER, generateForwardedHostShimCode(`./${moduleFile}`, exportName)];
  const shimPath = path.join(resource.bundle, shimFile);
  if (!fs.existsSync(shimPath) || fs.readFileSync(shimPath, 'utf-8') !== code) fs.writeFileSync(shimPath, code);
  return { ...resource, handler: shimHandler };
};

/**
 * Fail synth when the server compute can't be reached through the door. A Web
 * Function (`compute.type: 'web-function'`) is wired only as the CloudFront
 * door's server origin; every other door routes to Lambda functions (an ALB
 * target, an API Gateway integration, a `DoorInput` server origin), so behind
 * one the Web Function would deploy with no traffic reaching it.
 *
 * @param computeType the app's `compute.type`.
 * @param kind the resolved door kind (the stacked door's router is `'alb'` here).
 * @param label the door as the app wrote it, for the message. @default kind
 * @throws HostingError('UnsupportedComputeFrontDoorError') for a Web Function behind a door other than CloudFront.
 * @internal Framework-only.
 */
const assertComputeReachableByDoor = (
  computeType: 'lambda' | 'web-function' | undefined,
  kind: string,
  label: string = kind,
): void => {
  if (computeType !== 'web-function' || kind === 'cloudfront') return;
  throw new HostingError('UnsupportedComputeFrontDoorError', {
    message:
      `compute.type 'web-function' is not supported by the '${label}' front door. A Web Function is served only ` +
      "through the CloudFront door; this door routes to Lambda functions, so no request would reach it.",
    resolution:
      "Use the CloudFront door (omit `frontDoor`, or `'cloudfront'`), or remove `compute.type: 'web-function'` " +
      "(the default `'lambda'` works with every door).",
  });
};

/**
 * Fail synth when the app has middleware (Next.js `middleware.ts`, built as a
 * Lambda\@Edge function) and the door isn't CloudFront: only the CloudFront
 * door runs it (on viewer requests). Behind any other door the app would
 * deploy with its middleware — often its auth gate or redirects — silently
 * skipped.
 *
 * @param manifest the deploy manifest.
 * @param kind the resolved door kind.
 * @param label the door as the app wrote it, for the message. @default kind
 * @throws HostingError('MiddlewareNeedsCloudFrontDoorError') for middleware behind a door other than CloudFront.
 */
const assertMiddlewareReachableByDoor = (manifest: DeployManifest, kind: string, label: string = kind): void => {
  if (!manifest.middleware || kind === 'cloudfront') return;
  throw new HostingError('MiddlewareNeedsCloudFrontDoorError', {
    message:
      `The app has middleware (Next.js \`middleware.ts\`), which only the CloudFront door runs; the '${label}' front ` +
      'door would deploy the app with its middleware never running — and with it any route gating or redirects it does.',
    resolution:
      "Use the CloudFront door (omit `frontDoor`, or `'cloudfront'`), or move the middleware's logic into the pages " +
      'or route handlers before choosing another door.',
  });
};

/**
 * Fail synth for an API Gateway REST door with no custom domain (see the call
 * site). Making the stage the app's base path automatically is not possible:
 * each framework bakes its base path into the build from its own config, and
 * the AWS Blocks client fetches `/.blocks-sandbox/config.json` from the root.
 */
const assertRestDoorAddressable = (
  frontDoor: HostingConstructProps['frontDoor'],
  domain: HostingConstructProps['domain'],
): void => {
  if (typeof frontDoor !== 'object' || frontDoor === null || frontDoor.kind !== 'apiGateway' || frontDoor.api !== 'rest') return;
  if (domain) return;
  throw new HostingError('RestFrontDoorNeedsDomainError', {
    message:
      "frontDoor { kind: 'apiGateway', api: 'rest' } has no custom domain. A REST API's own URL carries the `/prod` " +
      "stage path, so the app's root-relative links (its assets, `/aws-blocks/api`, `/.blocks-sandbox/config.json`) " +
      'resolve outside the stage and get 403.',
    resolution:
      "Add `domain` (its base-path mapping serves the stage at the domain root), or use `api: 'http'` (the HTTP " +
      "API's `$default` stage has no path), or another door (the CloudFront default, `{ kind: 'alb' }`).",
  });
};

/**
 * Fail synth for an ALB door given a `certificate` but no custom domain: a
 * certificate can never cover the ALB's own `*.elb.amazonaws.com` name, so the
 * app is browsed at a domain of yours — which must then be the app's URL (the
 * trusted public origin and CORS hosting origin), or every RPC from it is
 * rejected.
 *
 * @throws HostingError('AlbCertificateNeedsDomainError') for a certificate without `features.domain`.
 */
const assertAlbCertificateHasDomain = (
  frontDoor: HostingConstructProps['frontDoor'],
  domain: HostingConstructProps['domain'],
): void => {
  if (typeof frontDoor !== 'object' || frontDoor === null) return;
  if ((frontDoor.kind !== 'alb' && frontDoor.kind !== 'stackedRouter') || !frontDoor.certificate) return;
  if (domain) return;
  throw new HostingError('AlbCertificateNeedsDomainError', {
    message:
      "frontDoor { kind: 'alb', certificate } has no custom domain. The certificate can't cover the load balancer's " +
      "own name, so the app is browsed at your domain — and the app's URL (its trusted origin and CORS origin) must be that domain.",
    resolution:
      "Add `frontDoor.features.domain` (`domainName`, plus `hostedZone` / `hostedZoneId` for the DNS records), " +
      'or remove `certificate` to serve plain HTTP at the ALB name.',
  });
};

/**
 * Walk a directory looking for files matching any of the given
 * extensions. Returns the set of extensions actually present so the
 * caller can skip emitting empty-on-arrival BucketDeployments.
 *
 * Used at synth time only — the directory has already been built before
 * the L3 runs. Errors (missing dir, permission, etc.) silently return
 * an empty set: the worst case is a missing font MIME pass, which is
 * the pre-fix behavior.
 */
/**
 * Coerce a `Duration | number` (seconds) into `Duration | undefined`.
 *
 * Public-API ergonomics: callers consuming the L3 from JS-compiled
 * wrappers (or strict TS users who write `timeout: 30`) often pass a
 * plain number. Without this coercion the value flows into
 * aws-cdk-lib's Lambda construct and crashes synth deep in framework
 * code with `props.timeout.toSeconds is not a function` — surfaced
 * by the AWS Blocks bug-bash repro (`@aws-blocks/blocks` Hosting
 * wrapper passing `timeout: 30` straight through). Normalize once
 * here so both shapes work and the type stays well-defined inside
 * the L3.
 */
const normalizeTimeout = (t?: Duration | number): Duration | undefined => {
  if (t === undefined) return undefined;
  if (typeof t === 'number') return Duration.seconds(t);
  return t;
};

const detectFontExtensions = (rootDir: string, extensions: readonly string[]): Set<string> => {
  const found = new Set<string>();
  const exts = new Set(extensions.map((e) => e.toLowerCase()));
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (exts.has(ext)) found.add(ext);
        if (found.size === exts.size) return;
      }
    }
  };
  walk(rootDir);
  return found;
};
