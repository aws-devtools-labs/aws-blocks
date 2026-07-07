import * as fs from 'node:fs';
import * as path from 'node:path';
import { Construct } from 'constructs';
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
} from 'aws-cdk-lib';
import { Provider } from 'aws-cdk-lib/custom-resources';
import {
  Distribution,
  IResponseHeadersPolicy,
  PriceClass,
  ResponseHeadersPolicy,
  experimental,
} from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import {
  BucketDeployment,
  CacheControl,
  Source,
} from 'aws-cdk-lib/aws-s3-deployment';
import {
  Alias,
  Code,
  FunctionUrl,
  IVersion,
  Function as LambdaFunction,
  Runtime,
} from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Rule, RuleTargetInput, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaFunctionTarget } from 'aws-cdk-lib/aws-events-targets';
import { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { IHostedZone } from 'aws-cdk-lib/aws-route53';
import { IKey } from 'aws-cdk-lib/aws-kms';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { DeployManifest } from '../manifest/types.js';
import { HostingError } from '../hosting_error.js';
import { HostingResources } from '../types.js';
import {
  partitionEnvironment,
  wireRuntimeSecret,
  type EnvValue,
  type SecretResolveOptions,
} from '../secret-resolve.js';
import { ERROR_PAGE_KEY, NOT_FOUND_PAGE_KEY, generateBuildId } from '../defaults.js';
import { StorageConstruct } from './storage_construct.js';
import { ComputeConstruct } from './compute_construct.js';
import { WafConstruct } from './waf_construct.js';
import { DnsConstruct } from './dns_construct.js';
import { createSecurityHeadersPolicy } from './security_headers.js';
import { CdnConstruct } from './cdn_construct.js';
import type { QuotaOverrides } from './quota_budget.js';
import { MonitoringConstruct } from './monitoring_construct.js';
import { ITopic, Topic } from 'aws-cdk-lib/aws-sns';

// Re-export build ID helpers for public API + tests
export { generateBuildIdFunctionCode, generateBuildId } from '../defaults.js';
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
   */
  skipRegionValidation?: boolean;

  /** Custom domain configuration. */
  domain?: HostingDomainConfig;
  /** WAF configuration. */
  waf?: HostingWafConfig;
  /** Compute (Lambda) overrides for all compute resources. */
  compute?: {
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
  /** CDN (CloudFront) configuration. */
  cdn?: {
    priceClass?: PriceClass;
    contentSecurityPolicy?: string;
    geoRestriction?: {
      type: 'whitelist' | 'blacklist';
      countries: string[];
    };
    /**
     * Default TTL for SSR/compute cache behaviors when the origin response
     * does not include a `Cache-Control` header. Set this to enable
     * CloudFront edge caching of SSR responses and improve hit ratio.
     *
     * When set, SSR responses without an explicit `Cache-Control` header
     * are cached at the edge for this duration. The origin can always
     * override via `s-maxage` or `no-store`.
     * @default Duration.seconds(0) — no caching unless origin opts in
     */
    ssrDefaultTtl?: Duration;
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
     */
    quotas?: QuotaOverrides;
  };
  /** S3 storage configuration. */
  storage?: {
    encryption?: 'S3_MANAGED' | 'KMS';
    encryptionKey?: IKey;
    retainOnDelete?: boolean;
    buildRetentionDays?: number;
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
  /** CloudFront access logging configuration. */
  logging?: {
    enabled: boolean;
    retentionDays?: number;
  };
  /**
   * Custom environment variables for all compute functions. Values may be
   * plain strings or {@link secret} markers. A `secret('K')` marker is wired at
   * RUNTIME (secure default): the store locator is injected and the compute
   * role granted read+decrypt; the app reads it via `getSecret('K')`. This
   * makes runtime secrets work for ANY consumer of the construct (Blocks,
   * standalone, Amplify) with no extra plumbing.
   *
   * Synth-time markers (`secret(..., { exposeAsEnv: true })`, domain secrets)
   * require async resolution and must be pre-resolved by the async wrapper
   * layer (e.g. `Hosting.create()`) — passing one here throws.
   */
  environment?: Record<string, EnvValue>;
  /**
   * Namespace + backing store for `secret()` markers in `environment`.
   * Defaults to the neutral `/hosting/secrets` prefix on SSM. A branded
   * consumer overrides the prefix (e.g. Blocks passes `/blocks/secrets`).
   */
  secrets?: SecretResolveOptions;
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
   */
  monitoring?: {
    /** @default true */
    enabled?: boolean;
    snsTopicArn?: string;
  };
  /**
   * Cookie-based skew protection.
   * When enabled, users mid-session keep receiving assets from their original
   * build, preventing asset mismatches during rolling deployments.
   * @default \{ enabled: true \} — skew protection is enabled by default.
   * Set `\{ enabled: false \}` to disable.
   */
  skewProtection?: {
    enabled: boolean;
    /** How long to honor old build cookies (seconds). Default: 86400 (24h) */
    maxAge?: number;
  };
};

// ---- Main construct ----

/**
 * Unified, manifest-driven hosting construct.
 *
 * Always creates: S3 bucket (private, BLOCK_ALL), CloudFront distribution,
 * OAC, atomic deployment with Build ID.
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
  readonly distribution: Distribution;
  readonly distributionUrl: string;
  readonly computeFunctions: Map<
    string,
    LambdaFunction | experimental.EdgeFunction
  > = new Map();
  readonly computeFunctionUrls: Map<string, FunctionUrl> = new Map();
  /**
   * `live` aliases for compute resources with provisioned concurrency.
   * Passed to the CDN so the SSR REST API integration targets the warm
   * alias instead of `$LATEST`.
   */
  readonly computeAliases: Map<string, Alias> = new Map();
  readonly certificate?: ICertificate;
  readonly hostedZone?: IHostedZone;
  readonly webAcl?: CfnWebACL;
  readonly cacheTable?: Table;
  readonly revalidationQueue?: Queue;
  readonly buildCacheBucket?: Bucket;
  readonly revalidationDlq?: Queue;
  readonly cacheBucket?: Bucket;
  /**
   * SNS topic alarm actions are sent to. Set when monitoring is on
   * (the default). The user subscribes (email, Slack via webhook,
   * PagerDuty, etc.) via `monitoringTopic.addSubscription(...)` or by
   * configuring an external listener with the topic ARN.
   *
   * Not declared `readonly` because the `MonitoringConstruct` that
   * owns the topic is built mid-constructor (after the SSR / image-opt
   * Lambdas it alarms on are wired up), so the value is assigned
   * after the field declaration runs. Treat it as logically immutable
   * post-construction — do not reassign from outside the constructor.
   */
  monitoringTopic?: ITopic;

  /**
   * Creates the hosting infrastructure from a framework-agnostic deploy manifest.
   */
  constructor(
    scope: Construct,
    id: string,
    props: HostingConstructProps,
  ) {
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

    // Skew-protection cookie must not outlive the build artifacts it pins
    // to. A `maxAge` longer than `buildRetentionDays` lets a returning
    // viewer present a cookie for a build whose `builds/<id>/` prefix the
    // S3 lifecycle rule has already deleted → hard 403 on every asset.
    if (props.skewProtection?.enabled && props.skewProtection.maxAge) {
      const retentionDays = props.storage?.buildRetentionDays ?? 30;
      const retentionSeconds = retentionDays * 24 * 60 * 60;
      if (props.skewProtection.maxAge > retentionSeconds) {
        throw new HostingError('InvalidSkewProtectionMaxAgeError', {
          message: `skewProtection.maxAge (${props.skewProtection.maxAge}s) exceeds storage.buildRetentionDays (${retentionDays}d = ${retentionSeconds}s).`,
          resolution:
            'Lower skewProtection.maxAge to at most storage.buildRetentionDays (in seconds), or raise storage.buildRetentionDays. A cookie that outlives the build prefix pins returning viewers to a deleted build → 403.',
        });
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
      accessLogging: props.logging?.enabled ?? true,
      encryption: props.storage?.encryption,
      encryptionKey: props.storage?.encryptionKey,
      buildRetentionDays: props.storage?.buildRetentionDays,
      logRetentionDays: props.logging?.retentionDays,
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

      const computeConstruct = new ComputeConstruct(this, `Compute-${name}`, {
        name,
        computeResource: resource,
        memorySize: props.compute?.memorySize,
        timeout: computeTimeout,
        reservedConcurrency: props.compute?.reservedConcurrency,
        // Forward the L3 user-facing provisioned-concurrency knob to the SSR
        // compute. Previously this was silently dropped — only a
        // manifest-level value (which adapters don't set from user input) was
        // honored, so `compute.provisionedConcurrency` was inert.
        provisionedConcurrency: isSsrCompute
          ? props.compute?.provisionedConcurrency
          : undefined,
        logRetention: props.compute?.logRetention,
        skipRegionValidation: props.skipRegionValidation,
        skipFunctionUrl: isSsrCompute,
        environment: props.compute?.environment,
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
      const cacheFunction = this.computeFunctions.get(cacheComputeName);
      if (!cacheFunction) {
        throw new HostingError('CacheComputeResourceNotFoundError', {
          message: `Cache config references compute resource '${cacheComputeName}' but it was not found in manifest.compute`,
          resolution:
            'Ensure cache.computeResource matches a key in the compute map.',
        });
      }
      this.cacheBucket.grantReadWrite(cacheFunction);

      if (cacheFunction instanceof LambdaFunction) {
        cacheFunction.addEnvironment(
          'HOSTING_NITRO_CACHE_BUCKET',
          this.cacheBucket.bucketName,
        );
        cacheFunction.addEnvironment(
          'HOSTING_NITRO_CACHE_REGION',
          Stack.of(this).region,
        );
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
        const revalidationLogGroup = new LogGroup(
          this,
          'RevalidationLogGroup',
          {
            retention: props.compute?.logRetention ?? RetentionDays.TWO_WEEKS,
            removalPolicy: RemovalPolicy.DESTROY,
          },
        );

        const revalidationFn = new LambdaFunction(
          this,
          'RevalidationFunction',
          {
            runtime: Runtime.NODEJS_20_X,
            handler: manifest.cache.revalidationFunction.handler,
            code: Code.fromAsset(manifest.cache.revalidationFunction.bundle),
            timeout: Duration.seconds(30),
            memorySize: 256,
            logGroup: revalidationLogGroup,
            environment: {
              CACHE_BUCKET_NAME: this.cacheBucket.bucketName,
              CACHE_BUCKET_REGION: Stack.of(this).region,
              OPEN_NEXT_BUILD_ID: buildId,
              ...(this.cacheTable
                ? { CACHE_DYNAMO_TABLE: this.cacheTable.tableName }
                : {}),
            },
          },
        );

        this.cacheBucket.grantReadWrite(revalidationFn);
        if (this.cacheTable) {
          this.cacheTable.grantReadWriteData(revalidationFn);
        }

        revalidationFn.addEventSource(
          new SqsEventSource(this.revalidationQueue, { batchSize: 5 }),
        );

        this.computeFunctions.set('revalidation', revalidationFn);
      }

      // Grant cache access to the target compute resource
      const cacheComputeName = manifest.cache.computeResource;
      const cacheFunction = this.computeFunctions.get(cacheComputeName);
      if (!cacheFunction) {
        throw new HostingError('CacheComputeResourceNotFoundError', {
          message: `Cache config references compute resource '${cacheComputeName}' but it was not found in manifest.compute`,
          resolution:
            'Ensure cache.computeResource matches a key in the compute map.',
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
      if (cacheFunction instanceof LambdaFunction) {
        cacheFunction.addEnvironment(
          'CACHE_BUCKET_NAME',
          this.cacheBucket.bucketName,
        );
        cacheFunction.addEnvironment(
          'CACHE_BUCKET_REGION',
          Stack.of(this).region,
        );
        cacheFunction.addEnvironment('OPEN_NEXT_BUILD_ID', buildId);
        if (this.cacheTable) {
          cacheFunction.addEnvironment(
            'CACHE_DYNAMO_TABLE',
            this.cacheTable.tableName,
          );
        }
        if (this.revalidationQueue) {
          cacheFunction.addEnvironment(
            'REVALIDATION_QUEUE_URL',
            this.revalidationQueue.queueUrl,
          );
          cacheFunction.addEnvironment(
            'REVALIDATION_QUEUE_REGION',
            Stack.of(this).region,
          );
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
          runtime: Runtime.NODEJS_20_X,
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
        new CustomResource(this, 'IsrTagTableSeed', {
          serviceToken: initProvider.serviceToken,
          properties: { buildId },
        });
      }
    }

    // ---- 4. Image optimization Lambda ----
    if (manifest.imageOptimization) {
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
        this.computeFunctionUrls.set(
          'image-optimization',
          imageConstruct.functionUrl,
        );
      }
      // Image optimization needs to read original images from the assets bucket
      this.bucket.grantRead(imageConstruct.function);

      // Environment variables required by OpenNext image optimization
      if (imageConstruct.function instanceof LambdaFunction) {
        imageConstruct.function.addEnvironment(
          'BUCKET_NAME',
          this.bucket.bucketName,
        );
        imageConstruct.function.addEnvironment(
          'BUCKET_KEY_PREFIX',
          `builds/${buildId}`,
        );
        imageConstruct.function.addEnvironment(
          'BUCKET_REGION',
          Stack.of(this).region,
        );
        // Adapter-supplied env (e.g. IPX_BASE_URL for @nuxt/image
        // when the user customizes `runtimeConfig.ipx.baseURL`).
        if (manifest.imageOptimization.environment) {
          for (const [key, value] of Object.entries(
            manifest.imageOptimization.environment,
          )) {
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
        if (
          manifest.imageOptimization.remotePatterns &&
          manifest.imageOptimization.remotePatterns.length > 0
        ) {
          imageConstruct.function.addEnvironment(
            'IMAGE_REMOTE_PATTERNS',
            JSON.stringify(manifest.imageOptimization.remotePatterns),
          );
        }
        // Astro `image.domains` / Next.js `images.domains` ship as a
        // CSV of bare hostnames — simpler shape than remotePatterns,
        // honored by the IPX runtime allowlist (P0.1 enforcement).
        if (
          manifest.imageOptimization.domains &&
          manifest.imageOptimization.domains.length > 0
        ) {
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
          imageConstruct.function.addEnvironment(
            'IMAGE_FORMATS',
            manifest.imageOptimization.formats.join(','),
          );
        }
        if (manifest.imageOptimization.sizes.length > 0) {
          imageConstruct.function.addEnvironment(
            'IMAGE_DEVICE_SIZES',
            manifest.imageOptimization.sizes.join(','),
          );
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
    const RESERVED_PREFIXES = [
      'AWS_',
      'HOSTING_',
      'OPEN_NEXT_',
      'CACHE_',
      'REVALIDATION_',
      'NODE_',
      'LAMBDA_',
    ];
    const RESERVED_EXACT_KEYS = new Set([
      '_HANDLER',
      'LD_PRELOAD',
      '_X_AMZN_TRACE_ID',
    ]);
    const KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

    if (props.environment) {
      // Split markers from plain strings. Runtime secrets are wired below;
      // exposeAsEnv/synth-time markers must be pre-resolved by the async
      // wrapper layer, so any that reach here are a caller error.
      const { plain, runtimeSecrets, exposeSecrets } = partitionEnvironment(props.environment);
      if (exposeSecrets.length > 0) {
        throw new HostingError('UnresolvedSecretError', {
          message: `exposeAsEnv secret(s) [${exposeSecrets
            .map((s) => s.key)
            .join(', ')}] reached HostingConstruct unresolved.`,
          resolution:
            'Synth-time secrets must be resolved before construction — use the async create() wrapper (e.g. Hosting.create).',
        });
      }

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
            resolution:
              'Lambda environment variable keys must be 256 characters or fewer.',
          });
        }
        const value = plain[key];
        if (value.length > 8192) {
          throw new HostingError('EnvironmentValueTooLongError', {
            message: `Environment variable value for '${key}' exceeds 8KB limit.`,
            resolution:
              'Lambda environment variable values must be 8192 characters or fewer.',
          });
        }
      }

      for (const [, fn] of this.computeFunctions.entries()) {
        if (fn instanceof LambdaFunction) {
          for (const [key, value] of Object.entries(plain)) {
            fn.addEnvironment(key, value);
          }
          // Runtime secret markers: inject the store locator + grant read/decrypt.
          for (const s of runtimeSecrets) {
            wireRuntimeSecret(fn, s.key, props.secrets);
          }
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
      for (const [name, fn] of this.computeFunctions) {
        if (!(fn instanceof LambdaFunction)) continue;
        fn.addEnvironment('OTEL_EXPORTER_OTLP_ENDPOINT', tracing.otelEndpoint);
        if (tracing.otelHeaders) {
          fn.addEnvironment('OTEL_EXPORTER_OTLP_HEADERS', tracing.otelHeaders);
        }
        // Per-function service name disambiguates traces in
        // collectors that aggregate by service. e.g. `<base>-ssr`,
        // `<base>-image-optimization`, `<base>-revalidation`.
        fn.addEnvironment(
          'OTEL_SERVICE_NAME',
          name === 'default' || name === 'server'
            ? `${serviceName}-ssr`
            : `${serviceName}-${name}`,
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
      const ssrFn = ssrComputeName
        ? this.computeFunctions.get(ssrComputeName)
        : undefined;
      // Warmup only applies to `handler`-type compute (OpenNext): the
      // synthetic event is a raw JSON object the handler can detect and
      // short-circuit. `http-server` compute (Nitro / Astro behind the
      // Lambda Web Adapter) expects an HTTP-shaped event — a raw JSON
      // payload would 500 on every warmup invoke, turning a cost
      // optimization into an error-rate generator. Skip it (and warn)
      // rather than synthesize an HTTP event we'd have to keep in sync
      // with LWA's expected shape.
      const ssrComputeType = ssrComputeName
        ? manifest.compute[ssrComputeName]?.type
        : undefined;
      if (ssrFn instanceof LambdaFunction && ssrComputeType === 'handler') {
        const rule = new Rule(this, 'WarmupSchedule', {
          schedule: Schedule.rate(props.compute.warmup.rate),
          description:
            '2.1 — keep SSR Lambda warm with a synthetic invoke every N.',
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

    // ---- 6. WAF (conditional) ----
    // Determine effective WebACL ARN: waf.webAclArn > cdn.webAclArn > create new
    const effectiveWebAclArn = props.waf?.webAclArn ?? props.cdn?.webAclArn;
    if (!effectiveWebAclArn) {
      const wafConstruct = new WafConstruct(this, 'Waf', {
        enabled: props.waf?.enabled ?? false,
        rateLimit: props.waf?.rateLimit,
        skipRegionValidation: props.skipRegionValidation,
      });
      this.webAcl = wafConstruct.webAcl;
    }

    // ---- 7. Custom domain resources (conditional) ----
    const dnsConstructs: DnsConstruct[] = [];
    let resolvedDomainNames: string[] = [];
    if (props.domain) {
      // Resolve domain names from single string or array
      resolvedDomainNames = Array.isArray(props.domain.domainName)
        ? props.domain.domainName
        : [props.domain.domainName];

      // Create DNS construct for the first/primary domain (handles certificate)
      const primaryDomain = resolvedDomainNames[0];
      const primaryDns = new DnsConstruct(this, 'Dns', {
        domainName: primaryDomain,
        hostedZone: props.domain.hostedZone,
        hostedZoneId: props.domain.hostedZoneId,
        certificate: props.domain.certificate,
        skipRegionValidation: props.skipRegionValidation,
      });
      dnsConstructs.push(primaryDns);
      this.certificate = primaryDns.certificate;
      this.hostedZone = primaryDns.hostedZone;

      // Additional domains share the same certificate but get separate DNS records
      for (let i = 1; i < resolvedDomainNames.length; i++) {
        const additionalDns = new DnsConstruct(this, `Dns${i + 1}`, {
          domainName: resolvedDomainNames[i],
          hostedZone: props.domain.hostedZone,
          hostedZoneId: props.domain.hostedZoneId,
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
    let securityHeadersPolicy: IResponseHeadersPolicy;
    if (props.cdn?.responseHeadersPolicy) {
      securityHeadersPolicy = props.cdn.responseHeadersPolicy;
    } else if (props.cdn?.contentSecurityPolicy) {
      securityHeadersPolicy = createSecurityHeadersPolicy(
        this,
        'SecurityHeaders',
        { contentSecurityPolicy: props.cdn.contentSecurityPolicy },
      );
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

    const cdn = new CdnConstruct(this, 'Cdn', {
      bucket: this.bucket,
      manifest: manifestWithBuildId,
      securityHeadersPolicy,
      contentSecurityPolicy: props.cdn?.contentSecurityPolicy,
      computeFunctionUrls: this.computeFunctionUrls,
      computeFunctions: this.computeFunctions,
      computeAliases: this.computeAliases,
      middlewareEdgeFunction: middlewareEdgeVersion,
      routeEdgeFunctions,
      webAcl: this.webAcl,
      certificate: this.certificate,
      domainName:
        resolvedDomainNames.length > 0 ? resolvedDomainNames : undefined,
      wwwRedirect: props.domain?.wwwRedirect,
      accessLogBucket: storage.accessLogBucket,
      priceClass: props.cdn?.priceClass,
      geoRestriction: props.cdn?.geoRestriction,
      skewProtection: props.skewProtection ?? { enabled: true },
      ssrDefaultTtl: props.cdn?.ssrDefaultTtl,
      webAclArn: effectiveWebAclArn ?? props.cdn?.webAclArn,
      quotas: props.cdn?.quotas,
      customErrorPages: props.errorPages
        ? {
            notFound: !!props.errorPages.notFound,
            serverError: !!props.errorPages.serverError,
          }
        : undefined,
    });

    this.distribution = cdn.distribution;
    this.distributionUrl = cdn.distributionUrl;

    // Output the CloudFront distribution domain when custom domain is configured.
    // BYO domain users need this to set up their external DNS CNAME.
    if (resolvedDomainNames.length > 0) {
      new CfnOutput(this, 'DistributionDomainName', {
        value: this.distribution.distributionDomainName,
        description:
          'CloudFront distribution domain name. Point your DNS CNAME to this value.',
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
      const autoDeleteCr = storage.accessLogBucket.node.tryFindChild(
        'AutoDeleteObjectsCustomResource',
      );
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
    const monitoringEnabled = props.monitoring?.enabled ?? true;
    if (monitoringEnabled) {
      const userTopic = props.monitoring?.snsTopicArn
        ? Topic.fromTopicArn(
            this,
            'AlarmTopicImport',
            props.monitoring.snsTopicArn,
          )
        : undefined;
      const ssrComputeName = this.computeFunctions.has('default')
        ? 'default'
        : this.computeFunctions.has('server')
          ? 'server'
          : undefined;
      const ssrFn = ssrComputeName
        ? this.computeFunctions.get(ssrComputeName)
        : undefined;
      const imgFn = this.computeFunctions.get('image-optimization');
      const monitoring = new MonitoringConstruct(this, 'Monitoring', {
        enabled: true,
        snsTopic: userTopic,
        distribution: this.distribution,
        // Lambda@Edge functions don't accept the CW metric helpers we
        // use; only attach when the SSR compute is a regional Lambda.
        ssrFunction: ssrFn instanceof LambdaFunction ? ssrFn : undefined,
        imageFunction: imgFn instanceof LambdaFunction ? imgFn : undefined,
        revalidationDlq: this.revalidationDlq,
      });
      this.monitoringTopic = monitoring.topic;
      if (monitoring.topic) {
        new CfnOutput(this, 'MonitoringTopicArn', {
          value: monitoring.topic.topicArn,
          description:
            'SNS topic for hosting alarms. Subscribe an email/Slack/PagerDuty endpoint here.',
        });
      }
    }

    // ---- 9a. OPEN_NEXT_ORIGIN env var for URL construction ----
    // OpenNext's origin resolver (pattern-env) reads OPEN_NEXT_ORIGIN as a JSON
    // map of origin names → {host, protocol, port}. Only the primary server
    // function needs this — it enables internal routing to resolve origins for
    // URL construction (avoiding "TypeError: Invalid URL" on path-only rewrites).
    // Image optimization and other secondary compute functions don't need it.
    if (hasCompute) {
      // Identify the primary server function (the one handling SSR routing)
      const primaryComputeName = this.computeFunctions.has('default')
        ? 'default'
        : this.computeFunctions.has('server')
          ? 'server'
          : [...this.computeFunctions.keys()].find(
              (k) => k !== 'image-optimization' && k !== 'middleware',
            );

      if (primaryComputeName) {
        const primaryFn = this.computeFunctions.get(primaryComputeName);
        if (primaryFn && primaryFn instanceof LambdaFunction) {
          // Build origin map with OTHER functions' URLs (not self → avoids cycle)
          const originEntries: string[] = [];
          for (const [urlName, fnUrl] of this.computeFunctionUrls.entries()) {
            if (urlName === primaryComputeName) continue;
            const originKey =
              urlName === 'image-optimization' ? 'imageOptimizer' : urlName;
            const host = Fn.select(2, Fn.split('/', fnUrl.url));
            originEntries.push(
              Fn.join('', [
                `"${originKey}":{"host":"`,
                host,
                `","protocol":"https","port":443}`,
              ]),
            );
          }

          if (originEntries.length > 0) {
            const openNextOriginJson = Fn.join('', [
              '{',
              Fn.join(',', originEntries),
              '}',
            ]);
            primaryFn.addEnvironment('OPEN_NEXT_ORIGIN', openNextOriginJson);
          } else {
            primaryFn.addEnvironment('OPEN_NEXT_ORIGIN', '{}');
          }
        }
      }
    }

    // ---- 9b. KMS decrypt grant for CloudFront OAC ----
    const kmsKey = props.storage?.encryptionKey ?? storage.bucket.encryptionKey;
    if (props.storage?.encryption === 'KMS' && kmsKey) {
      kmsKey.addToResourcePolicy(
        new iam.PolicyStatement({
          actions: ['kms:Decrypt'],
          resources: ['*'],
          principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        }),
      );
    }

    // ---- 10. DNS records ----
    if (props.domain && dnsConstructs.length > 0) {
      for (const dns of dnsConstructs) {
        dns.createDnsRecords(this.distribution);
      }
    }

    // ---- 11. Error page deployment (SSR only) ----
    // Every BucketDeployment that writes to the new build's
    // `builds/${buildId}/` prefix is collected here. After they are all
    // declared, the CloudFront build-id functions are made to depend on
    // them (see `cdn.addBuildAssetDependency` at the end of this method) so
    // the buildId cutover never races ahead of the asset uploads.
    const buildAssetDeployments: BucketDeployment[] = [];
    if (hasCompute) {
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
    // Set by the CDN construct only for multi-page static sites
    // (spaFallback === false) that shipped no 404.html and got no
    // user-supplied notFound page. Deploy it so the wired CloudFront 403/404
    // → /builds/<id>/_not_found.html responses resolve from S3.
    if (cdn.defaultNotFoundPageHtml) {
      new BucketDeployment(this, 'DefaultNotFoundPageDeployment', {
        sources: [Source.data(NOT_FOUND_PAGE_KEY, cdn.defaultNotFoundPageHtml)],
        destinationBucket: this.bucket,
        destinationKeyPrefix: `builds/${buildId}/`,
        prune: false,
      });
    }

    // ---- 11a. Custom error pages ----
    if (props.errorPages?.notFound) {
      if (!fs.existsSync(props.errorPages.notFound)) {
        throw new HostingError('CustomErrorPageNotFoundError', {
          message: `Custom 404 error page not found at path: ${props.errorPages.notFound}`,
          resolution:
            'Ensure the notFound path points to an existing HTML file relative to your project root.',
        });
      }
      const notFoundContent = fs.readFileSync(
        props.errorPages.notFound,
        'utf-8',
      );
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
          resolution:
            'Ensure the file contains valid HTML (should include <html> or <!DOCTYPE> tag).',
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
          resolution:
            'Ensure the serverError path points to an existing HTML file relative to your project root.',
        });
      }
      const serverErrorContent = fs.readFileSync(
        props.errorPages.serverError,
        'utf-8',
      );
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
          resolution:
            'Ensure the file contains valid HTML (should include <html> or <!DOCTYPE> tag).',
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
        description:
          'S3 bucket for framework build cache. Sync .next/cache (or equivalent) in CI.',
      });

      // Set env var on all compute functions so they know the bucket name
      for (const [, fn] of this.computeFunctions.entries()) {
        if (fn instanceof LambdaFunction) {
          fn.addEnvironment(
            'HOSTING_BUILD_CACHE_BUCKET',
            this.buildCacheBucket.bucketName,
          );
        }
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
    const immutablePaths = manifest.staticAssets.immutablePaths;
    const noCachePaths = manifest.staticAssets.noCachePaths;
    const mutableCacheControl =
      manifest.staticAssets.cacheControl ??
      'public, s-maxage=31536000, max-age=0, must-revalidate';
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
      ephemeralStorageSize: Size.mebibytes(
        props.storage?.deployment?.ephemeralStorageMiB ?? 1024,
      ),
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
          cacheControl: [
            CacheControl.fromString('public, max-age=31536000, immutable'),
          ],
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
      const fontDeployment = new BucketDeployment(
        this,
        `FontTypeDeployment${ext.replace('.', '')}`,
        {
          sources: [staticSource],
          destinationBucket: this.bucket,
          destinationKeyPrefix: `builds/${buildId}/`,
          exclude: ['*'],
          include: [`*${ext}`],
          contentType: mime,
          cacheControl: [CacheControl.fromString(mutableCacheControl)],
          prune: false,
          ...deploymentSizing,
        },
      );
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

    // ---- 12c. Gate the build-id cutover on the asset uploads ----
    // Make the CloudFront build-id functions (viewer-request, and the
    // Next.js assetPrefix strip function) depend on every BucketDeployment
    // that writes the new build's `builds/${buildId}/` prefix. CloudFormation
    // therefore uploads all assets FIRST and only then publishes the
    // functions / updates the distribution to route at the new buildId.
    // Without this, the buildId could propagate globally before the assets
    // landed, 403-ing new/cookieless visitors for the deploy window.
    for (const dep of buildAssetDeployments) {
      cdn.addBuildAssetDependency(dep);
    }

    // ---- CloudFormation resource-count guard ----
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
   * Get the hosting resources for output wiring.
   */
  getResources(): HostingResources {
    return {
      bucket: this.bucket,
      distribution: this.distribution,
      distributionUrl: this.distributionUrl,
      buildCacheBucket: this.buildCacheBucket,
    };
  }
}

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

const detectFontExtensions = (
  rootDir: string,
  extensions: readonly string[],
): Set<string> => {
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
