import { createHash } from 'node:crypto';
import { Construct, type IDependable } from 'constructs';
import { CfnOutput, Duration, Fn, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  AllowedMethods,
  BehaviorOptions,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CachePolicy,
  CacheQueryStringBehavior,
  Function as CloudFrontFunction,
  Distribution,
  ErrorResponse,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  GeoRestriction,
  HttpVersion,
  IOrigin,
  IResponseHeadersPolicy,
  KeyValueStore,
  LambdaEdgeEventType,
  OriginRequestCookieBehavior,
  OriginRequestHeaderBehavior,
  OriginRequestPolicy,
  OriginRequestQueryStringBehavior,
  PriceClass,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import {
  FunctionUrlOrigin,
  HttpOrigin,
  S3BucketOrigin,
} from 'aws-cdk-lib/aws-cloudfront-origins';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment } from 'aws-cdk-lib/aws-s3-deployment';
import {
  CfnPermission,
  IFunction,
  IFunctionUrl,
  IVersion,
} from 'aws-cdk-lib/aws-lambda';
import { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import {
  EndpointType,
  LambdaIntegration,
  ResponseTransferMode,
  RestApi,
} from 'aws-cdk-lib/aws-apigateway';
import { HostingError } from '../hosting_error.js';
import { prependBasePath } from '../adapters/shared/basepath.js';
import { DeployManifest } from '../manifest/types.js';
import { ERROR_PAGE_KEY, NOT_FOUND_PAGE_KEY } from '../defaults.js';
import { SkewProtectionConfig } from './skew_protection.js';
import { QuotaBudget, type QuotaOverrides } from './quota_budget.js';
import {
  ORIGIN_ID,
  buildKvsEntries,
  generateKvsRouterRequestCode,
  generateKvsRouterResponseCode,
  generateSentinelGuardCode,
  generateEdgeBasePathStripCode,
  routeSpecificity,
} from './kvs_router.js';
import { KvKeys } from './kv_keys.js';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';

// ---- Constants ----

/** Runtime version used for all CloudFront Functions in this construct. */
const CLOUDFRONT_FUNCTION_RUNTIME = FunctionRuntime.JS_2_0;

/**
 * Headroom (in edge-function slots) below the effective Lambda@Edge quota at
 * which we emit a stderr warning, so a distribution approaching the account
 * limit is flagged before it fails. Other distributions in the same account
 * count against the same quota.
 */
const EDGE_FUNCTIONS_WARNING_HEADROOM = 5;

const SSR_ERROR_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Service Temporarily Unavailable</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb;color:#374151}
.c{text-align:center;max-width:480px;padding:2rem}h1{font-size:1.5rem;margin-bottom:.5rem}p{color:#6b7280}</style></head>
<body><div class="c"><h1>Service Temporarily Unavailable</h1><p>We're working on it. Please try again in a few moments.</p></div></body></html>`;

// Built-in default 404 page for multi-page static sites that ship no
// 404.html of their own. Returned at HTTP 404 (not the SPA 200 fallback)
// so crawlers and clients see a correct not-found status.
const DEFAULT_NOT_FOUND_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>404 — Page Not Found</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb;color:#374151}
.c{text-align:center;max-width:480px;padding:2rem}h1{font-size:1.5rem;margin-bottom:.5rem}p{color:#6b7280}</style></head>
<body><div class="c"><h1>404 — Page Not Found</h1><p>The page you're looking for doesn't exist.</p></div></body></html>`;

// ---- Public types ----

/**
 * Props for the CdnConstruct.
 */
export type CdnConstructProps = {
  /** S3 origin bucket for static assets. */
  bucket: IBucket;
  /** Deploy manifest containing routes, buildId, and compute config. */
  manifest: DeployManifest;
  /** CloudFront ResponseHeadersPolicy for security headers. */
  securityHeadersPolicy: IResponseHeadersPolicy;
  /**
   * Optional Content-Security-Policy value used when building per-pattern
   * ResponseHeadersPolicies for `manifest.headers[]`. Should match the
   * value used to build `securityHeadersPolicy`. If omitted, the
   * built-in default CSP is used.
   */
  contentSecurityPolicy?: string;
  /** Map of compute name → Function URL for per-origin routing. */
  computeFunctionUrls?: Map<string, IFunctionUrl>;
  /** Map of compute name → Lambda function for OAC permission patching. */
  computeFunctions?: Map<string, IFunction>;
  /**
   * Map of compute name → `live` alias for resources with provisioned
   * concurrency. When the SSR compute has an alias, the REST API
   * integration targets it (the warm alias) instead of `$LATEST`, so
   * provisioned instances actually serve request traffic.
   */
  computeAliases?: Map<string, IFunction>;
  /** WAFv2 WebACL to associate with the distribution. */
  webAcl?: CfnWebACL;
  /** ACM certificate for custom domain TLS. */
  certificate?: ICertificate;
  /** Custom domain name(s) for CloudFront aliases. */
  domainName?: string | string[];
  /**
   * www redirect mode. When set to 'toApex' or 'toWww', a CloudFront Function
   * redirects between www and apex domains.
   */
  wwwRedirect?: 'toApex' | 'toWww' | 'none';
  /** S3 bucket for CloudFront access logging. */
  accessLogBucket?: IBucket;
  /** CloudFront price class. Default: PRICE_CLASS_100 (US, Canada, Europe). */
  priceClass?: PriceClass;
  /** Geo-restriction configuration. */
  geoRestriction?: {
    type: 'whitelist' | 'blacklist';
    countries: string[];
  };
  /** Custom error page HTML. */
  errorPageHtml?: string;
  /** Custom error pages configuration for CloudFront error responses. */
  customErrorPages?: {
    notFound?: boolean;
    serverError?: boolean;
  };
  /** Lambda@Edge function version for middleware (viewer-request). */
  middlewareEdgeFunction?: IVersion;
  /**
   * Per-route Lambda@Edge function versions. Keyed by compute name; the
   * matching cache behavior gets `edgeLambdas` set with this function as
   * an origin-request association. Used for OpenNext edge routes
   * (`runtime = 'edge'`), one entry per route.
   */
  routeEdgeFunctions?: Map<string, IVersion>;
  /** Cookie-based skew protection configuration. */
  skewProtection?: SkewProtectionConfig;
  /**
   * Default TTL for SSR/compute cache behaviors when the origin doesn't
   * set Cache-Control. Enables CDN caching of dynamic responses.
   * @default Duration.seconds(0)
   */
  ssrDefaultTtl?: Duration;
  /**
   * ARN of an existing WAFv2 WebACL. When set, takes precedence over
   * the `webAcl` construct reference.
   */
  webAclArn?: string;
  /**
   * Overrides for the adjustable AWS Service Quotas this distribution draws
   * on (cache behaviors, Lambda@Edge associations, response-headers policies).
   * Omitted fields use AWS defaults. Set a field only to match a quota
   * increase AWS has actually granted — see {@link QuotaOverrides}.
   */
  quotas?: QuotaOverrides;
};

// ---- Construct ----

/**
 * CloudFront distribution with cache behaviors derived from the DeployManifest.
 *
 * Routes targeting 'static' go to S3.
 * Routes targeting a named compute resource go to the Lambda Function URL origin.
 */
export class CdnConstruct extends Construct {
  readonly distribution: Distribution;
  readonly distributionUrl: string;
  readonly errorPageHtml: string;
  /**
   * Built-in default 404 page HTML, set ONLY when this is a multi-page
   * static deploy (`spaFallback === false`) that has no framework-emitted
   * or user-supplied 404 page. `undefined` otherwise. When set, the L3
   * deploys it to `builds/<id>/_not_found.html` and CloudFront serves it
   * (at HTTP 404) for missing paths. See {@link NOT_FOUND_PAGE_KEY}.
   */
  readonly defaultNotFoundPageHtml?: string;

  /**
   * Resources whose update is the atomic-deploy cutover and therefore MUST
   * happen only after the new build's assets are uploaded to S3. Under KVS
   * routing this is the {@link KvKeys} custom resource — its UpdateKeys call
   * flips `buildId`/routes to the new build, so it must depend on every asset
   * BucketDeployment. (Previously this was the build-id CloudFront Functions,
   * which baked the buildId as a literal; now the buildId lives in KVS and the
   * router function is build-independent.) See {@link addBuildAssetDependency}.
   */
  private readonly buildAssetGatedResources: Construct[] = [];

  /**
   * Count of asset deployments registered via {@link addBuildAssetDependency}.
   * The synth-time validation in the constructor uses this to detect a
   * regression where the cutover is left ungated (the KVS route table would
   * flip to the new build before its assets are uploaded, re-opening the 403
   * deploy window).
   */
  private buildAssetDependencyCount = 0;

  /**
   * Creates the CDN distribution with routes mapped to origins.
   */
  constructor(scope: Construct, id: string, props: CdnConstructProps) {
    super(scope, id);

    const { manifest, bucket } = props;

    if (!manifest.buildId) {
      throw new HostingError('MissingBuildIdError', {
        message: 'Deploy manifest must include a buildId.',
        resolution:
          'Ensure your adapter generates a buildId in the deploy manifest.',
      });
    }

    if (props.geoRestriction && props.geoRestriction.countries.length === 0) {
      throw new HostingError('EmptyGeoRestrictionError', {
        message: 'geoRestriction.countries array cannot be empty.',
        resolution:
          'Provide at least one ISO 3166-1 alpha-2 country code, or remove the geoRestriction config.',
      });
    }

    const buildId = manifest.buildId;
    const account = Stack.of(this).account;
    const hasComputeRoutes = manifest.routes.some(
      (r) => r.target !== 'static' && r.target !== 's3',
    );
    const hasCompute =
      (props.computeFunctionUrls && props.computeFunctionUrls.size > 0) ||
      hasComputeRoutes;
    this.errorPageHtml = props.errorPageHtml ?? SSR_ERROR_PAGE_HTML;

    // ---- Lambda@Edge function-count validation ----
    // The KVS single-behavior model removed the per-route cache-behavior and
    // response-headers-policy caps that used to need running-total accounting,
    // so the ONLY adjustable quota this construct still enforces is the
    // Lambda@Edge function count. We read its (possibly overridden) limit and
    // check eagerly — the count is known up front. `QuotaBudget` is used purely
    // for the override-aware `limit()` lookup here.
    const budget = new QuotaBudget(props.quotas);
    const edgeRouteCount = props.routeEdgeFunctions?.size ?? 0;
    const edgeLimit = budget.limit('edgeFunctions');
    if (edgeRouteCount > edgeLimit) {
      throw new HostingError('TooManyEdgeRoutesError', {
        message: `This distribution declares ${edgeRouteCount} edge-runtime routes, exceeding the Lambda@Edge limit of ${edgeLimit} replicated functions per account.`,
        resolution:
          'Reduce the number of routes that export `runtime: "edge"`, ' +
          'consolidate edge logic into fewer routes (e.g. one router that ' +
          'switches on path), raise the `quotas.edgeFunctions` hosting prop if ' +
          'AWS has granted your account a higher limit, or request a ' +
          'service-quota increase: ' +
          'https://docs.aws.amazon.com/lambda/latest/dg/edge-functions-restrictions.html',
      });
    }
    if (edgeRouteCount >= edgeLimit - EDGE_FUNCTIONS_WARNING_HEADROOM) {
      process.stderr.write(
        `⚠️  Hosting: this distribution declares ${edgeRouteCount} edge-runtime routes. ` +
          `The Lambda@Edge limit is ${edgeLimit} per account; ` +
          `other distributions in the same account count against the same quota.\n`,
      );
    }

    const skewEnabled = props.skewProtection?.enabled === true;
    const skewMaxAge = props.skewProtection?.maxAge ?? 86400;
    // Redirects (basePath-prefixed) are written into the KVS route table by
    // buildKvsEntries(); the edge router evaluates them per request. No CF
    // Function redirect table or 100-entry cap anymore.

    // ---- Build ID rewrite function ----
    // SPA fallback: when true, navigation requests (no file extension) are
    // rewritten to /index.html so a client-side router can deep-link any
    // path. When false, each path resolves to its own <path>/index.html
    // (directory-index) — correct for multi-page static sites. Asset
    // requests (.js, .css) pass through unchanged either way so missing
    // assets correctly 403/404 instead of serving HTML.
    //
    // Prefer the adapter's explicit `staticAssets.spaFallback` signal (the
    // adapter is the only layer that knows the framework's routing model).
    // Fall back to the legacy heuristic — static-only AND no errorPages —
    // for adapters that don't yet declare it. This coupling of "has error
    // pages" to "is a SPA" was the original misclassification: a multi-page
    // static site with no custom 404 was wrongly treated as a SPA.
    const isSpaFallback =
      manifest.staticAssets.spaFallback ??
      (!hasCompute &&
        (manifest.errorPages === undefined ||
          Object.keys(manifest.errorPages).length === 0));

    // Multi-page static site (not SPA) that emitted no 404.html of its
    // own AND whose user supplied no custom notFound page → fill the gap
    // with a built-in default 404 so missing paths render a branded page
    // (at HTTP 404) instead of CloudFront's raw S3-OAC 403 XML. SPA sites
    // are excluded (their miss correctly serves index.html at 200); SSR
    // sites already have SSR_ERROR_PAGE_HTML. Precedence:
    // user errorPages.notFound > framework errorPages[404] > this default.
    const hasFrameworkNotFound = !!manifest.errorPages?.[404];
    const hasUserNotFound = !!props.customErrorPages?.notFound;
    const needsDefaultNotFound =
      !hasCompute &&
      !isSpaFallback &&
      !hasFrameworkNotFound &&
      !hasUserNotFound;
    this.defaultNotFoundPageHtml = needsDefaultNotFound
      ? DEFAULT_NOT_FOUND_PAGE_HTML
      : undefined;

    // NOTE: routing/build-id/skew/forwarded-host/assetPrefix are now all
    // handled by the single KVS edge router (see the "KVS edge routing"
    // section below). The legacy per-behavior CloudFront Functions
    // (createViewerRequestFunction / createViewerResponseFunction /
    // forwardedHostFunction) are no longer created. `isSpaFallback`,
    // `manifestRedirects`, `skewEnabled`, `skewMaxAge`, and `wwwRedirect`
    // flow into the router's KVS data instead.

    // ---- Origins ----
    // Every origin gets a STABLE origin id so the KVS edge router can target
    // it with cf.selectRequestOriginById(). The S3 origin backs the single
    // default behavior; the server + image origins are attached to the
    // distribution via an L1 override (CloudFront allows origins that no
    // behavior references — they're reachable only via the router).
    const s3Origin = S3BucketOrigin.withOriginAccessControl(bucket, {
      originId: ORIGIN_ID.s3,
    });

    // SSR Lambda goes through API Gateway REST API + STREAM mode instead of
    // OAC + Function URL. OAC SigV4 includes the body hash; Function URL
    // recomputes it from received bytes and the two diverge, returning 403
    // on every non-empty POST/PUT/PATCH. REST API uses lambda:InvokeFunction
    // (no body re-hash) and is currently the only API GW flavor that
    // supports ResponseTransferMode.STREAM for Lambda proxy integrations.
    //
    // The Lambda must be built with a payload-v1 converter + streaming
    // wrapper (REST API sends v1; most adapters default to v2). Image-opt
    // and other GET-only compute stay on OAC + FURL.
    const computeOrigins = new Map<string, IOrigin>();
    const ssrComputeName: 'default' | 'server' | undefined =
      props.computeFunctions?.has('default')
        ? 'default'
        : props.computeFunctions?.has('server')
          ? 'server'
          : undefined;

    // Hoisted out of the SSR branch so the IPX image Lambda can share the SAME
    // API Gateway (see the image-origin wiring below). `restApi`/`apiHostname`
    // are set only when an SSR compute exists; `originVerifySecret` is the
    // deterministic CloudFront→APIGW auth token both integrations reuse.
    let restApi: RestApi | undefined;
    let apiHostname: string | undefined;
    // Origin verification secret — prevents direct APIGW access bypassing
    // CloudFront's security headers (CSP/HSTS). Requests without this
    // header are rejected by the APIGW resource policy.
    // Deterministic: derived from stack + construct path to avoid
    // CloudFormation churn on every deploy. Bump the version suffix to rotate.
    const originVerifySecret = createHash('sha256')
      .update(Stack.of(this).stackName)
      .update(this.node.path)
      .update('origin-verify-v1')
      .digest('hex');

    if (ssrComputeName && props.computeFunctions) {
      // Target the warm `live` alias when provisioned concurrency is set;
      // otherwise the unqualified function ($LATEST). Without this, the
      // REST integration always hit $LATEST and provisioned instances on
      // the alias sat idle.
      const ssrFn =
        props.computeAliases?.get(ssrComputeName) ??
        props.computeFunctions.get(ssrComputeName)!;

      // REGIONAL: CloudFront is already in front; edge-optimized would
      // double-proxy and cap streaming idle timeout at 30s.
      restApi = new RestApi(this, 'SsrRestApi', {
        endpointTypes: [EndpointType.REGIONAL],
        deployOptions: { stageName: 'prod' },
        // Treat all bodies as binary. Without this, API Gateway base64-encodes
        // request bodies (Lambda then sees 2× size) and re-encodes responses,
        // breaking binary uploads, downloads, and streaming.
        binaryMediaTypes: ['*/*'],
        // Resource policy: ALLOW everything (CloudFront origin reach
        // hits this), DENY anything missing the deterministic Referer
        // secret CloudFront injects on every origin request. Direct
        // hits to the stage URL surface as 403 from API GW before the
        // Lambda is invoked.
        policy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              principals: [new iam.AnyPrincipal()],
              actions: ['execute-api:Invoke'],
              resources: ['execute-api:/*'],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.DENY,
              principals: [new iam.AnyPrincipal()],
              actions: ['execute-api:Invoke'],
              resources: ['execute-api:/*'],
              conditions: {
                StringNotEquals: {
                  [`aws:Referer`]: originVerifySecret,
                },
              },
            }),
          ],
        }),
      });
      const integration = new LambdaIntegration(ssrFn, {
        proxy: true,
        responseTransferMode: ResponseTransferMode.STREAM,
      });
      // Wire root + {proxy+} manually. CDK's addProxy({ anyMethod: true })
      // attaches a MOCK integration to the root (not our LambdaIntegration),
      // which breaks `/` with "Unable to parse statusCode".
      restApi.root.addMethod('ANY', integration);
      restApi.root.addResource('{proxy+}').addMethod('ANY', integration);

      // restApi.url is "https://{id}.execute-api.{region}.amazonaws.com/{stage}/";
      // HttpOrigin needs the bare host.
      apiHostname = Fn.select(2, Fn.split('/', restApi.url));
      computeOrigins.set(
        ssrComputeName,
        new HttpOrigin(apiHostname, {
          originPath: `/${restApi.deploymentStage.stageName}`,
          // CloudFront's customHeaders OVERWRITE any same-named viewer
          // header (documented), so a client sending `Referer:` cannot
          // reach the API GW with their own value here.
          customHeaders: {
            Referer: originVerifySecret,
          },
        }),
      );
    }

    // Other compute (image-opt etc.) stays on OAC + Function URL — GET-only,
    // not exposed to the body-hash bug. The SSR compute isn't in this map
    // (L3 skips its Function URL).
    if (props.computeFunctionUrls) {
      for (const [name, fnUrl] of props.computeFunctionUrls) {
        computeOrigins.set(
          name,
          FunctionUrlOrigin.withOriginAccessControl(fnUrl),
        );
      }
    }

    // ---- IPX image Lambda on the SHARED SSR API Gateway (issue #2) ----
    // The Nuxt IPX optimizer embeds a REMOTE source as an unencoded path
    // segment (`/_ipx/s_256x256/https://host/…`). An OAC Function URL signs
    // SigV4 over the canonical path; the literal `://` canonicalizes
    // differently on CloudFront vs the Function URL, so the signatures diverge
    // and the Lambda is never invoked (403 InvalidSignatureException). API
    // Gateway authorizes with the origin-verify Referer header instead of a
    // path signature, so a `://` in the path is inert. Attach the IPX Lambda
    // as a dedicated `<baseURL>/{proxy+}` resource on the SAME RestApi the SSR
    // Lambda already uses (no new API GW), and point the image origin at that
    // shared host. Scoped to IPX only: detected by `imageOptimization.baseURL`
    // (Nuxt sets it; Next's OpenNext image bundle does not and speaks Function
    // URL v2 events, so it stays on its Function URL). Requires an SSR compute
    // (hence a RestApi) — a static-only Nuxt deploy keeps the Function URL.
    const ipxBaseUrl = manifest.imageOptimization?.baseURL;
    const ipxFn = props.computeFunctions?.get('image-optimization');
    if (ipxBaseUrl && ipxFn && (!restApi || !apiHostname)) {
      // IPX is configured but there's no SSR compute (hence no shared RestApi)
      // to ride — a static-only Nuxt deploy. The IPX Lambda stays on its OAC
      // Function URL, where an unencoded `://` in a remote source path can
      // recur as a SigV4 403 (issue #2). Nudge at build time so the operator
      // isn't left debugging a non-obvious runtime 403.
      process.stderr.write(
        `⚠️  imageOptimization.baseURL (${ipxBaseUrl}) is set but no SSR compute ` +
          `exists — the IPX image Lambda will use a Function URL origin, where ` +
          `remote sources with reserved chars can hit a SigV4 403 (issue #2). ` +
          `Deploy with SSR compute to route IPX through the shared API Gateway.\n`,
      );
    }
    if (ipxBaseUrl && ipxFn && restApi && apiHostname) {
      const ipxIntegration = new LambdaIntegration(ipxFn, { proxy: true });
      // e.g. baseURL '/_ipx' → resource path segments ['_ipx'] + '{proxy+}'.
      // API Gateway matches this more-specific resource ahead of the SSR
      // root `{proxy+}`, so `/_ipx/...` hits the IPX Lambda and everything
      // else falls through to the SSR Lambda.
      const segments = ipxBaseUrl.split('/').filter(Boolean);
      let node = restApi.root;
      for (const seg of segments) {
        node = node.getResource(seg) ?? node.addResource(seg);
      }
      // The IPX Lambda needs the prefix itself (it matches `/_ipx`), so wire
      // ANY on both the prefix root and its `{proxy+}` catch-all.
      node.addMethod('ANY', ipxIntegration);
      node.addResource('{proxy+}').addMethod('ANY', ipxIntegration);

      // Override the image origin (was the Function URL) to the shared API GW.
      computeOrigins.set(
        'image-optimization',
        new HttpOrigin(apiHostname, {
          originPath: `/${restApi.deploymentStage.stageName}`,
          customHeaders: { Referer: originVerifySecret },
        }),
      );
    }

    // Primary origin: prefer 'default' > 'server' > first available
    const primaryOrigin =
      computeOrigins.get('default') ??
      computeOrigins.get('server') ??
      computeOrigins.values().next().value;

    if (hasCompute && !primaryOrigin) {
      throw new HostingError('NoComputeOriginsError', {
        message: 'No compute origins configured',
        resolution:
          'Ensure at least one compute resource is defined in the deploy manifest',
      });
    }

    // ---- Middleware (Lambda@Edge viewer-request) ----
    const edgeLambdas = props.middlewareEdgeFunction
      ? [
          {
            functionVersion: props.middlewareEdgeFunction,
            eventType: LambdaEdgeEventType.VIEWER_REQUEST,
          },
        ]
      : undefined;

    // x-forwarded-host: now set by the KVS router on compute-bound requests
    // (the router copies Host → x-forwarded-host before selecting the server
    // origin). Redirects + build-id rewrite are likewise handled by the router.

    // ---- SSR cache policy (B21) ----
    // CACHING_DISABLED used to short-circuit caching on every compute
    // behavior, which silently broke ISR/SWR: the framework's
    // `Cache-Control: s-max-age=N` header was emitted by the origin but
    // CloudFront never honored it. Every request hit Lambda regardless
    // of origin caching directives. This policy honors origin
    // Cache-Control while including the headers App Router needs to
    // separate RSC payloads from HTML responses (otherwise an RSC
    // prefetch's payload would be served to a full-page request).
    //
    // Min/default/max TTL bounds:
    // - minTtl: 0 — origin can opt out via `Cache-Control: no-store`
    // - defaultTtl: 0 — when origin sends no Cache-Control, no caching
    //   (preserves the safe default; SSR routes that forget to set
    //   Cache-Control still don't accidentally cache personalized
    //   responses)
    // - maxTtl: 1 year — clamps any wild origin values (e.g. corrupted
    //   Cache-Control: s-max-age=999999999)
    //
    // Content negotiation is handled by enableAcceptEncodingBrotli/Gzip
    // flags — CloudFront normalizes the Accept-Encoding header into
    // gzip|br|identity buckets internally, which is more efficient than
    // caching per literal header value. CloudFront forbids adding
    // 'accept-encoding' to the headerBehavior allowList alongside these
    // flags.
    //
    // The cache key includes the Next.js router headers (RSC, prefetch,
    // state tree, segment prefetch) so prefetch payloads don't bleed
    // into full-page responses. Cookies are explicitly excluded — any
    // route that varies on cookies must emit `Cache-Control: private`
    // to opt out.
    const ssrCachePolicy = hasCompute
      ? new CachePolicy(this, 'SsrCachePolicy', {
          comment:
            'SSR/ISR/SWR: honor origin Cache-Control; key on Next.js router headers',
          minTtl: Duration.seconds(0),
          defaultTtl: props.ssrDefaultTtl ?? Duration.seconds(0),
          maxTtl: Duration.days(365),
          headerBehavior: CacheHeaderBehavior.allowList(
            'rsc',
            'next-router-prefetch',
            'next-router-state-tree',
            'next-router-segment-prefetch',
            // Server Actions POST to the same URL as the page with a
            // `next-action: <hash>` header identifying which action ran.
            // CloudFront does not cache POST today, so the immediate
            // collision risk is theoretical, but the header is part of
            // OpenNext's request-routing contract and belongs in the
            // cache key for correctness.
            // See: node_modules/@opennextjs/aws/dist/core/routing/cacheInterceptor.js
            'next-action',
          ),
          // Allowlist Next.js's two preview-mode cookies so requests
          // carrying them cache-miss and re-render fresh from the SSR
          // Lambda. With the previous `none()` behavior, CloudFront
          // stripped the cookies and served the cached anonymous
          // response — Draft Mode silently broke.
          //
          // Hit-rate impact: requests WITHOUT these cookies (the vast
          // majority) cache-key the same as before, so normal-traffic
          // hit rate is unchanged. Requests WITH the cookies (CMS
          // preview sessions) cache-miss by design — that's the whole
          // point of Draft Mode.
          //
          // Cookie names verified from Next.js source:
          //   node_modules/next/dist/server/api-utils/index.js:113-114
          //     COOKIE_NAME_PRERENDER_BYPASS = '__prerender_bypass'
          //     COOKIE_NAME_PRERENDER_DATA   = '__next_preview_data'
          // CloudFront supports up to 10 cookies per cache policy; we
          // use 2.
          cookieBehavior: CacheCookieBehavior.allowList(
            '__prerender_bypass',
            '__next_preview_data',
          ),
          // Cache on all query strings EXCEPT Next's prefetch cache-buster
          // `_rsc`. The App Router appends a fresh random `_rsc=<hash>` to
          // every RSC prefetch; with `.all()` each distinct value is its own
          // cache entry, so every prefetch MISSes to the origin and the edge
          // cache is useless for RSC payloads (issue #11). `_rsc` only tags a
          // request as RSC — the actual RSC-vs-HTML distinction is already in
          // the cache key via the `rsc` header (allowlisted above) — so it's
          // safe to drop from the key. denyList only affects the CACHE KEY;
          // `_rsc` is still forwarded to the origin.
          queryStringBehavior: CacheQueryStringBehavior.denyList('_rsc'),
          enableAcceptEncodingBrotli: true,
          enableAcceptEncodingGzip: true,
        })
      : undefined;

    // The default behavior's cache policy:
    //   - compute deploys → `ssrCachePolicy` (honors origin Cache-Control, keys
    //     on the Next.js router headers).
    //   - pure-static deploys (`hasCompute === false`) → the AWS-managed
    //     `CACHING_OPTIMIZED`. Without this the static default behavior would
    //     fall back to `CACHING_DISABLED`, which ignores the origin's
    //     `Cache-Control` and turns every immutable hashed asset
    //     (`/_next/static/*`, `/_astro/*`, `/_nuxt/*`, carrying
    //     `max-age=31536000, immutable`) into an edge MISS to S3. This restores
    //     the edge caching the pre-KVS model gave via `makeStaticBehavior`,
    //     which also used `CACHING_OPTIMIZED`.
    //
    // Why the AWS-MANAGED `CACHING_OPTIMIZED` and not a custom `minTtl: 0`
    // policy: AWS-managed policies don't count against the per-account
    // "cache policies" quota (default 20), so a custom policy per static
    // distribution would burn that scarce account-wide limit (and fails to
    // deploy once the account is at the cap). `CACHING_OPTIMIZED` honors the
    // origin `Cache-Control` (immutable assets cache up to 1y); its `minTtl: 1s`
    // can briefly edge-cache the `no-cache` HTML, but that is SAFE across
    // deploys: every static request — HTML included — is rewritten to
    // `/builds/<buildId>/...` BEFORE the cache lookup, so the cache key is
    // build-scoped and a redeploy (new buildId) yields a new key rather than
    // serving the old build's HTML. Hashed asset filenames are content-addressed
    // on top. Within a build the HTML is identical, so the 1s window is benign.
    const defaultCachePolicy =
      ssrCachePolicy ?? CachePolicy.CACHING_OPTIMIZED;

    // ════════════════════════════════════════════════════════════════
    // KVS edge routing (single behavior + CloudFront Function + KVS).
    //
    // Instead of one CloudFront cache behavior per route (capped at 75/dist),
    // the distribution has ONE default behavior whose viewer-request function
    // reads the route table from a KeyValueStore and routes each request to the
    // right origin via cf.selectRequestOriginById(). Route count no longer
    // consumes behaviors, so the behavior-cap limit class is eliminated.
    //
    // Origins reachable from the router (by stable origin id):
    //   - ORIGIN_ID.s3      → static assets (the default behavior's origin)
    //   - ORIGIN_ID.server  → SSR Lambda via REST API GW (if compute)
    //   - ORIGIN_ID.image   → image-opt Lambda Function URL (if present)
    // The server/image origins are bound to the distribution via sentinel
    // behaviors on never-routed patterns (so CDK materializes them + their OAC
    // correctly); the router, not those behaviors, is what actually directs
    // traffic to them.
    // ════════════════════════════════════════════════════════════════

    const imageOrigin = computeOrigins.get('image-optimization');
    const serverOrigin = ssrComputeName
      ? computeOrigins.get(ssrComputeName)
      : undefined;

    // Re-tag the server + image origins with stable ids so the router can
    // select them. (S3 already carries ORIGIN_ID.s3.)
    const taggedServerOrigin = serverOrigin
      ? this.withOriginId(serverOrigin, ORIGIN_ID.server)
      : undefined;
    const taggedImageOrigin = imageOrigin
      ? this.withOriginId(imageOrigin, ORIGIN_ID.image)
      : undefined;

    // ---- KeyValueStore (route table) ----
    const routeStore = new KeyValueStore(this, 'RouteStore', {
      comment: `Edge route table for ${this.node.path}`,
    });

    // Lambda@Edge route functions (OpenNext `runtime: 'edge'` split bundles).
    // Each gets a DEDICATED CloudFront cache behavior below; exclude them from
    // the KVS route table so the router doesn't send them to the default
    // server Lambda (which doesn't contain the split routes → 500).
    const edgeTargets = new Set(props.routeEdgeFunctions?.keys() ?? []);

    const kvsEntries = buildKvsEntries({
      manifest,
      buildId,
      hasServer: Boolean(taggedServerOrigin),
      hasImage: Boolean(taggedImageOrigin),
      wwwRedirect: props.wwwRedirect,
      skewEnabled,
      edgeTargets,
      // Tunable route-table budget (issue #8) — raise via quotas.maxRouteChunks
      // for a very large site after verifying edge-function compute headroom.
      maxChunksPerTable: props.quotas?.maxRouteChunks,
    });

    // ---- Router functions (build-independent; routing data lives in KVS) ----
    const routerRequestFn = new CloudFrontFunction(this, 'KvsRouterRequest', {
      code: FunctionCode.fromInline(generateKvsRouterRequestCode()),
      runtime: CLOUDFRONT_FUNCTION_RUNTIME,
      keyValueStore: routeStore,
      comment: 'KVS edge router: origin selection + build-id rewrite',
    });
    // The router rewrites static requests to /builds/<buildId>/… where buildId
    // comes from KVS — so the atomic cutover is the gated KvKeys write, not the
    // function publish. The function itself is build-independent.
    const routerResponseFn = new CloudFrontFunction(this, 'KvsRouterResponse', {
      code: FunctionCode.fromInline(
        generateKvsRouterResponseCode(skewEnabled ? skewMaxAge : 0),
      ),
      runtime: CLOUDFRONT_FUNCTION_RUNTIME,
      keyValueStore: routeStore,
      comment: 'KVS edge router: per-pattern headers + skew cookie',
    });
    routerResponseFn.node.addDependency(routerRequestFn); // serialize creates

    // Guard for the sentinel behaviors: 403 any direct client request to the
    // never-routed origin-binding patterns (see sentinel behaviors below).
    // Created lazily — only when at least one sentinel behavior exists (i.e. a
    // server or image origin is bound). Pure-static deploys have no sentinels,
    // so no guard function is synthesized.
    let sentinelGuardFn: CloudFrontFunction | undefined;
    const getSentinelGuardFn = (): CloudFrontFunction => {
      if (!sentinelGuardFn) {
        sentinelGuardFn = new CloudFrontFunction(this, 'SentinelGuard', {
          code: FunctionCode.fromInline(generateSentinelGuardCode()),
          runtime: CLOUDFRONT_FUNCTION_RUNTIME,
          comment: 'KVS edge router: 403 direct hits to origin-binding sentinels',
        });
        sentinelGuardFn.node.addDependency(routerResponseFn); // serialize creates
      }
      return sentinelGuardFn;
    };

    // ---- KvKeys: live KVS update, gated on asset upload (atomic cutover) ----
    const kvKeys = new KvKeys(this, 'RouteStoreKeys', {
      store: routeStore,
      entries: kvsEntries,
    });
    // The KV write that flips buildId/routes to the new build must happen only
    // AFTER the new build's assets are in S3 — same invariant the build-id
    // functions enforced. Register the custom resource so the hosting construct
    // wires it via addBuildAssetDependency().
    this.buildAssetGatedResources.push(kvKeys.resource);

    // ---- Origin-request / cache policies for the single behavior ----
    // The default behavior must accept ALL methods (the router may send a
    // request to the SSR origin) and forward viewer data to the origin.
    //
    // Origin request policy: forward all viewer headers (except Host), cookies,
    // and query strings to whichever origin the KVS router selects. We can NOT
    // use the AWS-managed `ALL_VIEWER_EXCEPT_HOST_HEADER` here: the default
    // behavior's STATICALLY-attached origin is S3, and CloudFront rejects that
    // managed policy on an S3 origin — "S3 Origins can only use the following
    // managed request policies: CORS-CustomOrigin, CORS-S3Origin,
    // UserAgentRefererHeaders" (a 400 InvalidRequest at distribution create,
    // observed intermittently across regions). A CUSTOM policy with the same
    // forwarding is allowed on S3 origins. One custom policy is created per
    // distribution and shared by the default + sentinel behaviors, so it costs
    // a single origin-request-policy against the account quota (default 20).
    // Forward all viewer headers EXCEPT Host — matching the managed
    // ALL_VIEWER_EXCEPT_HOST_HEADER semantics. CDK has no "all except host"
    // constructor, so use denyList('host'): CloudFront still sends the correct
    // origin Host, and the KVS router injects `x-forwarded-host` for the
    // compute origin so the real viewer host is not lost.
    const forwardAllOriginRequestPolicy = hasCompute
      ? new OriginRequestPolicy(this, 'ForwardAllOriginRequestPolicy', {
          comment:
            'KVS router: forward all viewer data (except Host) to the selected origin',
          headerBehavior: OriginRequestHeaderBehavior.denyList('host'),
          cookieBehavior: OriginRequestCookieBehavior.all(),
          queryStringBehavior: OriginRequestQueryStringBehavior.all(),
        })
      : undefined;

    const defaultBehavior: BehaviorOptions = {
      origin: s3Origin,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy: defaultCachePolicy,
      compress: true,
      originRequestPolicy: forwardAllOriginRequestPolicy,
      responseHeadersPolicy: props.securityHeadersPolicy,
      ...(edgeLambdas ? { edgeLambdas } : {}),
      functionAssociations: [
        { function: routerRequestFn, eventType: FunctionEventType.VIEWER_REQUEST },
        { function: routerResponseFn, eventType: FunctionEventType.VIEWER_RESPONSE },
      ],
    };

    // ---- Sentinel behaviors to bind server + image origins ----
    // CDK only materializes an origin (and its OAC) when a behavior references
    // it. These never-routed patterns exist purely to bind those origins; the
    // router reaches them via selectRequestOriginById. They cost a fixed 1-2
    // behaviors total — NOT one-per-route — so the cap is still eliminated.
    const additionalBehaviors: Record<string, BehaviorOptions> = {};
    if (taggedServerOrigin) {
      additionalBehaviors['/__blocks_origin_server/*'] = {
        origin: taggedServerOrigin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: ssrCachePolicy ?? CachePolicy.CACHING_DISABLED,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: props.securityHeadersPolicy,
        functionAssociations: [
          { function: getSentinelGuardFn(), eventType: FunctionEventType.VIEWER_REQUEST },
        ],
      };
    }
    if (taggedImageOrigin) {
      additionalBehaviors['/__blocks_origin_image/*'] = {
        origin: taggedImageOrigin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: ssrCachePolicy ?? CachePolicy.CACHING_DISABLED,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: props.securityHeadersPolicy,
        functionAssociations: [
          { function: getSentinelGuardFn(), eventType: FunctionEventType.VIEWER_REQUEST },
        ],
      };
    }

    // ---- Lambda@Edge route behaviors (OpenNext `runtime: 'edge'` routes) ----
    // OpenNext SPLITS edge routes into separate bundles (edge1/edge2…) that are
    // NOT in the default server Lambda. Each needs a DEDICATED CloudFront cache
    // behavior (more specific than the default `*`, so it wins) with the
    // EdgeFunction attached on origin-request: the function generates the
    // response itself, so the behavior's origin (S3 here) is never read — it
    // only needs to be a well-formed origin. Without this the KVS router sends
    // these paths to the default server Lambda, which lacks the routes → 500.
    if (props.routeEdgeFunctions && props.routeEdgeFunctions.size > 0) {
      // CloudFront evaluates additional behaviors FIRST-MATCH-WINS with no
      // longest-prefix preference, so insert most-specific first: a literal
      // `/api/edge/special` must precede a wildcard `/api/edge/*` or the
      // wildcard shadows it. Sort the edge routes by specificity up front.
      const edgeRoutes = manifest.routes
        .filter((r) => props.routeEdgeFunctions?.has(r.target))
        .map((r) => ({
          route: r,
          pattern: prependBasePath(manifest.basePath, r.pattern),
        }))
        .sort((a, b) => routeSpecificity(b.pattern) - routeSpecificity(a.pattern));

      // basePath strip for edge behaviors. OpenNext compiles each edge bundle's
      // internal route table basePath-RELATIVE (regex `^/edge$`, `^/api/edge$`)
      // and matches it against the FULL request path. Under a deployed basePath
      // the behavior forwards `/app/edge`, which `^/edge$` does not match → the
      // bundle throws `No route found` → 503. These behaviors bypass the KVS
      // router (which strips basePath for the other origins), so attach a
      // viewer-request CloudFront Function that strips basePath before the
      // Lambda@Edge origin-request function runs. Created once, shared by every
      // edge behavior; only when a basePath is actually configured.
      let edgeBasePathStripFn: CloudFrontFunction | undefined;
      if (manifest.basePath) {
        edgeBasePathStripFn = new CloudFrontFunction(this, 'EdgeBasePathStrip', {
          code: FunctionCode.fromInline(
            generateEdgeBasePathStripCode(manifest.basePath),
          ),
          runtime: CLOUDFRONT_FUNCTION_RUNTIME,
          comment: `Strip basePath ${manifest.basePath} before edge-runtime Lambda@Edge`,
        });
        edgeBasePathStripFn.node.addDependency(routerResponseFn); // serialize creates
      }

      for (const { route, pattern } of edgeRoutes) {
        // An edge route mapped to the catch-all can't be expressed as a
        // dedicated behavior (CloudFront's default behavior IS `*`, and it's
        // bound to the KVS router → the edge bundle would never run). Fail loud
        // instead of silently falling through to a 500 at runtime.
        if (pattern === '/*' || pattern === '*') {
          throw new HostingError('EdgeCatchAllUnsupportedError', {
            message: `An edge-runtime route is mapped to the catch-all pattern "${pattern}". CloudFront's default behavior is reserved for the KVS router, so a catch-all edge function cannot be wired and would 500 at runtime.`,
            resolution:
              'Give the edge route a specific path pattern (e.g. `/api/edge`, ' +
              '`/edge/*`) rather than a catch-all, or move its logic to the SSR ' +
              'compute (non-edge) runtime.',
          });
        }
        additionalBehaviors[pattern] = {
          origin: s3Origin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          // Intentionally CACHING_DISABLED (not `ssrCachePolicy ?? …`): an edge
          // function computes the response per request, so edge routes opt OUT
          // of the SSR s-maxage caching. Keep this — don't restore ssrCachePolicy.
          cachePolicy: CachePolicy.CACHING_DISABLED,
          // This behavior's origin is S3 (line above), so it CANNOT use the
          // managed ALL_VIEWER_EXCEPT_HOST_HEADER — CloudFront rejects that
          // managed policy on any S3 origin (400 InvalidRequest at create).
          // Reuse the synthesized custom policy (same forwarding, allowed on S3
          // origins). An edge route implies a compute route, so hasCompute is
          // true and forwardAllOriginRequestPolicy is defined (and even if it
          // were undefined, the Lambda@Edge function generates the response, so
          // forwarded origin data is immaterial here anyway).
          originRequestPolicy: forwardAllOriginRequestPolicy,
          responseHeadersPolicy: props.securityHeadersPolicy,
          edgeLambdas: [
            {
              functionVersion: props.routeEdgeFunctions.get(route.target)!,
              eventType: LambdaEdgeEventType.ORIGIN_REQUEST,
              // POST/PUT App Router edge handlers only receive the request body
              // on origin-request when includeBody is set; without it the body
              // is empty.
              includeBody: true,
            },
          ],
          // Strip basePath at viewer-request (before the Lambda@Edge) so the
          // OpenNext edge bundle's basePath-relative route regex matches. Only
          // attached when a basePath is configured (see edgeBasePathStripFn).
          ...(edgeBasePathStripFn
            ? {
                functionAssociations: [
                  {
                    function: edgeBasePathStripFn,
                    eventType: FunctionEventType.VIEWER_REQUEST,
                  },
                ],
              }
            : {}),
        };
      }
    }

    // ---- Behavior-count cap (CloudFront hard limit, default 25) ----
    // Every entry in `additionalBehaviors` (sentinels + edge routes) is a real
    // CloudFront cache behavior and counts against the per-distribution cap
    // (1 default + N additional). Edge routes can approach it before the
    // edge-FUNCTION cap (also 25) trips, and the raw CloudFormation error is
    // opaque — surface a friendly one here instead.
    const additionalBehaviorCount = Object.keys(additionalBehaviors).length;
    const totalBehaviors = 1 + additionalBehaviorCount; // +1 for the default
    const behaviorLimit = budget.limit('cacheBehaviors');
    if (totalBehaviors > behaviorLimit) {
      throw new HostingError('TooManyCacheBehaviorsError', {
        message: `This distribution needs ${totalBehaviors} CloudFront cache behaviors (1 default + ${additionalBehaviorCount} for origin-binding sentinels and edge-runtime routes), exceeding the limit of ${behaviorLimit} per distribution.`,
        resolution:
          'Reduce the number of `runtime: "edge"` routes (each needs its own ' +
          'behavior), consolidate edge logic into fewer routes, raise the ' +
          '`quotas.cacheBehaviors` hosting prop if AWS granted your account a ' +
          'higher limit, or request a service-quota increase.',
      });
    }

    // ---- Error responses ----
    // Four modes:
    //  1. Compute origin → 502/503/504 → custom error page (preserves status).
    //  2. Static deploy WITH `manifest.errorPages` (Next.js `output: 'export'`,
    //     Astro static, etc.) → 403/404 → /404.html with status 404. S3
    //     with OAC returns 403 (not 404) for missing keys, so both must
    //     be handled.
    //  3. Static SPA (`spaFallback === true`) → 403/404 → /index.html with
    //     status 200 so the client-side router can deep-link any path.
    //     (Wired via the SPA-fallback viewer-request rewrite, not here.)
    //  4. Static multi-page (`spaFallback === false`) WITHOUT its own
    //     404.html and WITHOUT a user-supplied notFound → 403/404 → the
    //     built-in default 404 page at status 404 (see needsDefaultNotFound).
    const isSpaOnly = !hasCompute;
    const hasErrorPages =
      manifest.errorPages !== undefined &&
      Object.keys(manifest.errorPages).length > 0;

    const errorResponses: ErrorResponse[] = [
      ...(needsDefaultNotFound
        ? [
            // Multi-page static site with no framework/user 404 → map the
            // S3-OAC 403 (and any 404) onto the built-in default page,
            // surfacing a correct 404 status with a branded body.
            {
              httpStatus: 403,
              responseHttpStatus: 404,
              responsePagePath: `/builds/${buildId}/${NOT_FOUND_PAGE_KEY}`,
              ttl: Duration.seconds(0),
            },
            {
              httpStatus: 404,
              responseHttpStatus: 404,
              responsePagePath: `/builds/${buildId}/${NOT_FOUND_PAGE_KEY}`,
              ttl: Duration.seconds(0),
            },
          ]
        : []),
      ...(isSpaOnly && hasErrorPages
        ? [
            // S3 with OAC returns 403 for missing keys — map to the
            // custom 404 page so deep links render the framework's
            // not-found page instead of a raw CloudFront error.
            {
              httpStatus: 403,
              responseHttpStatus: 404,
              responsePagePath: `/builds/${buildId}${manifest.errorPages?.[404] ?? '/index.html'}`,
              ttl: Duration.seconds(0),
            },
            ...(manifest.errorPages?.[404]
              ? [
                  {
                    httpStatus: 404,
                    responseHttpStatus: 404,
                    responsePagePath: `/builds/${buildId}${manifest.errorPages[404]}`,
                    ttl: Duration.seconds(0),
                  },
                ]
              : []),
            ...(manifest.errorPages?.[500]
              ? [
                  {
                    httpStatus: 500,
                    responseHttpStatus: 500,
                    responsePagePath: `/builds/${buildId}${manifest.errorPages[500]}`,
                    ttl: Duration.seconds(0),
                  },
                ]
              : []),
          ]
        : []),
      ...(hasCompute
        ? [
            // 500: Don't cache Lambda 500s — they're likely transient.
            // Image-opt Lambda returns 500 for missing images; caching
            // that error would serve stale errors to all users.
            {
              httpStatus: 500,
              responseHttpStatus: 500,
              responsePagePath: `/builds/${buildId}/${ERROR_PAGE_KEY}`,
              ttl: Duration.seconds(0),
            },
            {
              httpStatus: 502,
              responseHttpStatus: 502,
              responsePagePath: `/builds/${buildId}/${ERROR_PAGE_KEY}`,
              ttl: Duration.seconds(10),
            },
            {
              httpStatus: 503,
              responseHttpStatus: 503,
              responsePagePath: `/builds/${buildId}/${ERROR_PAGE_KEY}`,
              ttl: Duration.seconds(10),
            },
            {
              httpStatus: 504,
              responseHttpStatus: 504,
              responsePagePath: `/builds/${buildId}/${ERROR_PAGE_KEY}`,
              ttl: Duration.seconds(10),
            },
          ]
        : []),
    ];

    // ---- Custom error pages (user-provided) ----
    if (props.customErrorPages?.notFound) {
      errorResponses.push({
        httpStatus: 404,
        responseHttpStatus: 404,
        responsePagePath: `/builds/${buildId}/404.html`,
        ttl: Duration.seconds(0),
      });
    }
    if (props.customErrorPages?.serverError) {
      // For compute (SSR) stacks, the default 502/503/504 error pages are
      // already wired above; only add 500 with the custom page.
      // For static/SPA stacks, add all server error statuses.
      const serverErrorStatuses = hasCompute ? [500] : [500, 502, 503, 504];
      for (const status of serverErrorStatuses) {
        errorResponses.push({
          httpStatus: status,
          responseHttpStatus: status,
          responsePagePath: `/builds/${buildId}/500.html`,
          ttl: Duration.seconds(10),
        });
      }
    }


    // ---- Distribution ----
    this.distribution = new Distribution(this, 'HostingDistribution', {
      defaultBehavior,
      additionalBehaviors:
        Object.keys(additionalBehaviors).length > 0
          ? additionalBehaviors
          : undefined,
      httpVersion: HttpVersion.HTTP2_AND_3,
      priceClass: props.priceClass ?? PriceClass.PRICE_CLASS_100,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      ...(props.certificate && props.domainName
        ? {
            domainNames: Array.isArray(props.domainName)
              ? props.domainName
              : [props.domainName],
            certificate: props.certificate,
          }
        : {}),
      ...(props.webAclArn
        ? { webAclId: props.webAclArn }
        : props.webAcl
          ? { webAclId: props.webAcl.attrArn }
          : {}),
      ...(props.accessLogBucket
        ? { enableLogging: true, logBucket: props.accessLogBucket }
        : {}),
      ...(props.geoRestriction
        ? {
            geoRestriction:
              props.geoRestriction.type === 'whitelist'
                ? GeoRestriction.allowlist(...props.geoRestriction.countries)
                : GeoRestriction.denylist(...props.geoRestriction.countries),
          }
        : {}),
      errorResponses: errorResponses.length > 0 ? errorResponses : undefined,
    });

    // ---- OAC: S3 bucket policy ----
    // GetObject for serving assets, plus ListBucket so S3 returns a real
    // 404 (NoSuchKey) — not a 403 (AccessDenied) — for a missing key.
    //
    // Without s3:ListBucket, S3 hides key existence: a GET for an object the
    // caller can't confirm exists returns 403 AccessDenied. Under OAC that
    // 403 + S3's raw `<Error><Code>AccessDenied</Code></Error>` XML is
    // forwarded straight to the viewer (issue #9): wrong semantics (a missing
    // asset should be 404, not 403) and an info leak (it advertises an S3
    // origin and its error schema). Granting ListBucket flips a missing-key
    // GET to a clean 404 NoSuchKey. This is safe: the bucket is private and
    // reachable only through this distribution's OAC (same SourceArn
    // condition), so no key names are exposed to the public. We keep the fix
    // at the bucket-policy layer rather than a distribution-wide
    // `customErrorResponses` 403→404 map because the single-behavior KVS
    // model shares one error-response set across the S3 AND compute origins —
    // remapping there would clobber a framework/SSR route's own 404/403.
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [bucket.arnForObjects('*')],
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': `arn:aws:cloudfront::${account}:distribution/${this.distribution.distributionId}`,
          },
        },
      }),
    );
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [bucket.bucketArn],
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': `arn:aws:cloudfront::${account}:distribution/${this.distribution.distributionId}`,
          },
        },
      }),
    );

    // ---- OAC: Lambda Function URL permissions ----
    if (hasCompute) {
      // Remove CDK auto-generated CfnPermission resources for Function URL origins.
      // We create our own explicit permissions below with correct function ARNs.
      for (const child of this.distribution.node.findAll()) {
        if (
          child instanceof CfnPermission &&
          child.action === 'lambda:InvokeFunctionUrl'
        ) {
          child.node.scope?.node.tryRemoveChild(child.node.id);
        }
      }

      // Grant InvokeFunctionUrl only to OAC-fronted compute. The SSR Lambda
      // gets its grant from LambdaIntegration's auto-attached resource policy.
      const computeFnsWithUrls: Array<{ name: string; fn: IFunction }> = [];
      if (props.computeFunctionUrls && props.computeFunctions) {
        for (const [name] of props.computeFunctionUrls) {
          const fn = props.computeFunctions.get(name);
          if (fn) {
            computeFnsWithUrls.push({ name, fn });
          }
        }
      }

      for (const { name, fn } of computeFnsWithUrls) {
        new CfnPermission(this, `LambdaUrlPermission-${name}`, {
          action: 'lambda:InvokeFunctionUrl',
          principal: 'cloudfront.amazonaws.com',
          functionName: fn.functionArn,
          functionUrlAuthType: 'AWS_IAM',
          sourceArn: `arn:aws:cloudfront::${account}:distribution/${this.distribution.distributionId}`,
        });

        fn.addPermission(`CloudFrontOACInvoke-${name}`, {
          principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
          action: 'lambda:InvokeFunction',
          sourceArn: `arn:aws:cloudfront::${account}:distribution/${this.distribution.distributionId}`,
        });
      }
    }

    // ---- Distribution URL ----
    const domainNames = Array.isArray(props.domainName)
      ? props.domainName
      : props.domainName
        ? [props.domainName]
        : [];
    const primaryDomain = domainNames[0];
    this.distributionUrl = primaryDomain
      ? `https://${primaryDomain}`
      : `https://${this.distribution.distributionDomainName}`;

    // ---- Outputs ----
    new CfnOutput(this, 'DistributionUrl', {
      value: this.distributionUrl,
      description: 'URL for the hosted site',
    });

    if (primaryDomain) {
      new CfnOutput(this, 'CustomDomain', {
        value: primaryDomain,
        description: 'Custom domain name for the hosted site',
      });
    }

    // ---- Deploy-time CloudFront invalidation (adapter-declared) ----
    // Scoped on `hasCompute`, NOT on the framework. Any compute-backed deploy
    // can edge-cache HTML that goes stale after a redeploy: the shared SSR
    // cache policy honors the origin's `Cache-Control`, so HTML served by the
    // compute origin with a long `s-maxage` is edge-cached keyed on the viewer
    // path (not the build-id prefix) and ends up referencing the previous
    // build's hashed assets → 403. This is not Next-specific — it also hits
    // Nuxt `routeRules` swr/isr and Astro SSR (see the field doc in
    // manifest/types.ts). Pure-static deploys (no compute) serve HTML from S3
    // with `no-cache`, so they need no invalidation and get none.
    //
    // Default: `['/*']` for any deploy with compute; nothing for pure-static.
    // `manifest.invalidationPaths` OVERRIDES the default — set explicit
    // patterns to narrow it, or `[]` to opt out.
    //
    // Ordering: the invalidation MUST run after the KvKeys atomic cutover
    // (which is itself asset-gated via addBuildAssetDependency). That way it
    // only flushes the PREVIOUS build's cached pages; the new build's
    // `builds/<id>/...` objects were never cached, so `/*` is effectively free
    // and cannot evict the not-yet-requested new prefix. `wait: false` is
    // implied — AwsCustomResource does not poll the invalidation to completion,
    // matching SST's non-blocking model (a brief propagation window where a
    // first-time/cookieless visitor may still receive stale HTML is accepted).
    const invalidationPaths = manifest.invalidationPaths ??
      (hasCompute ? ['/*'] : []);
    if (invalidationPaths.length > 0) {
      const invalidation = new AwsCustomResource(this, 'DeployInvalidation', {
        // CallerReference keyed on buildId so a NEW deploy (new buildId) issues
        // a fresh invalidation, while an unchanged buildId is a no-op (CFN sees
        // identical props → no Update → no duplicate invalidation cost).
        onUpdate: {
          service: 'CloudFront',
          action: 'createInvalidation',
          parameters: {
            DistributionId: this.distribution.distributionId,
            InvalidationBatch: {
              CallerReference: `blocks-${buildId}`,
              Paths: {
                Quantity: invalidationPaths.length,
                Items: invalidationPaths,
              },
            },
          },
          physicalResourceId: PhysicalResourceId.of(
            `invalidation-${buildId}`,
          ),
        },
        // createInvalidation is not resource-scopable in IAM; the action must
        // be granted on `*` (the distribution ARN is not a valid resource for
        // this action). Scope the policy to the single action.
        policy: AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['cloudfront:CreateInvalidation'],
            resources: ['*'],
          }),
        ]),
      });
      // Gate AFTER the atomic KVS cutover so we only flush the previous build's
      // pages (see ordering note above).
      invalidation.node.addDependency(kvKeys.resource);
    }

    // ---- Self-enforcing atomic-deploy guard ----
    // The KVS router rewrites every static request to `/builds/<buildId>/...`
    // where `buildId` comes from the KVS route table. The KvKeys custom
    // resource writes that table; if it runs before the new build's assets are
    // uploaded to the OAC-protected bucket, new/cookieless visitors get 403 for
    // the whole deploy window. `addBuildAssetDependency` wires each asset
    // BucketDeployment as a dependency of the KvKeys resource so CloudFormation
    // uploads first. This validation fails synth if the gated cutover resource
    // exists alongside asset deployments but NONE were registered — i.e. the
    // wiring loop in the hosting construct was removed/broken, silently
    // re-opening the 403 window.
    this.node.addValidation({
      validate: (): string[] => {
        // No gated cutover resource -> nothing to gate.
        if (this.buildAssetGatedResources.length === 0) return [];
        // At least one asset deployment was wired -> invariant holds.
        if (this.buildAssetDependencyCount > 0) return [];
        // Nothing was wired. Only fail if asset BucketDeployments actually
        // exist in this stack; a standalone CdnConstruct with no assets is
        // legitimate and must not false-positive.
        const hasAssetDeployments = Stack.of(this)
          .node.findAll()
          .some((c) => c instanceof BucketDeployment);
        if (!hasAssetDeployments) return [];
        return [
          `CdnConstruct '${this.node.path}' writes the KVS route table (which ` +
            'flips traffic to /builds/<buildId>/...), but no asset ' +
            'BucketDeployment was registered via addBuildAssetDependency(). ' +
            'The route-table cutover would happen before the new build assets ' +
            'are uploaded, returning 403 Access Denied to new/cookieless ' +
            'visitors for the entire deploy window. An asset BucketDeployment ' +
            'was likely added without calling ' +
            'cdn.addBuildAssetDependency(deployment).',
        ];
      },
    });
  }

  /**
   * Assign a stable CloudFront origin id to an already-constructed origin so
   * the KVS edge router can target it with `cf.selectRequestOriginById()`.
   * Wraps the origin's `bind()` to inject the id into the returned config.
   */
  private withOriginId(origin: IOrigin, originId: string): IOrigin {
    return {
      bind: (scope, options) => {
        const config = origin.bind(scope, options);
        return {
          ...config,
          originProperty: config.originProperty
            ? { ...config.originProperty, id: originId }
            : config.originProperty,
        };
      },
    };
  }

  /**
   * Register a dependency that must finish before the atomic-deploy cutover.
   *
   * Under KVS routing the cutover is the {@link KvKeys} UpdateKeys call that
   * flips `buildId`/routes to the new build. If it runs before the new build's
   * assets land at `/builds/<buildId>/...` in the OAC-protected S3 bucket,
   * new/cookieless visitors get 403 Access Denied for the deploy window
   * (returning visitors with a `__dpl` skew cookie keep hitting the previous
   * build and are unaffected).
   *
   * The hosting construct calls this with every asset `BucketDeployment` for
   * the new build, so CloudFormation uploads the assets first and only then
   * updates the KVS route table. This makes redeploys atomic from a new
   * visitor's perspective.
   */
  addBuildAssetDependency(dependency: IDependable): void {
    for (const resource of this.buildAssetGatedResources) {
      resource.node.addDependency(dependency);
    }
    this.buildAssetDependencyCount += 1;
  }
}
