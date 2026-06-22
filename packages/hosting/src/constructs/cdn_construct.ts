import { createHash } from 'node:crypto';
import { Construct, IDependable } from 'constructs';
import { CfnOutput, Duration, Fn, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  AllowedMethods,
  BehaviorOptions,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CachePolicy,
  CacheQueryStringBehavior,
  CachedMethods,
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
  LambdaEdgeEventType,
  OriginRequestPolicy,
  PriceClass,
  ResponseHeadersPolicy,
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
import { DeployManifest, Redirect } from '../manifest/types.js';
import {
  ERROR_PAGE_KEY,
  NOT_FOUND_PAGE_KEY,
  generateAssetPrefixStripFunctionCode,
  generateBuildIdAndRedirectFunctionCode,
  generateForwardedHostAndRedirectFunctionCode,
} from '../defaults.js';
import {
  createCustomHeadersPolicy,
  containsSecurityHeader,
} from './security_headers.js';
import {
  SkewProtectionConfig,
  generateSkewProtectionViewerRequestCode,
  generateSkewProtectionViewerResponseCode,
} from './skew_protection.js';
import { QuotaBudget, type QuotaOverrides } from './quota_budget.js';

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
   * CloudFront Functions that bake the deploy's buildId into the request
   * rewrite (`/builds/<buildId>/...`). Publishing one of these is the moment
   * the distribution starts routing new/cookieless traffic at the new build,
   * so they must not update until that build's assets have been uploaded.
   * See {@link addBuildAssetDependency}.
   */
  private readonly buildIdFunctions: CloudFrontFunction[] = [];

  /**
   * Count of asset deployments registered via {@link addBuildAssetDependency}.
   * The synth-time validation added in the constructor uses this to detect a
   * regression where the build-id cutover is left ungated (every build-id
   * function would publish before the new build's assets are uploaded,
   * re-opening the 403 deploy window).
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

    // Central accounting for the adjustable quotas this distribution draws on.
    // Consumers call budget.consume() as they allocate; the authoritative
    // budget.assertWithinLimits() runs just before the Distribution is created.
    const budget = new QuotaBudget(props.quotas);
    // The behavior budget counts the FULL CloudFront limit (default + N
    // additional), so the additional-behavior ceiling is `limit - 1`. Sourced
    // from the budget so a `quotas.cacheBehaviors` override is honored instead
    // of a hardcoded constant. Used by both the per-pattern header cap check
    // and the authoritative count near the end.
    const maxAdditionalBehaviors = budget.limit('cacheBehaviors') - 1;

    // ---- Lambda@Edge function-count validation ----
    // Edge functions are validated eagerly (their count is known up front and
    // is independent of behavior allocation). The cache-behavior and
    // header-policy budgets are consumed incrementally below and enforced by
    // the single assertWithinLimits() call near the end.
    const edgeRouteCount = props.routeEdgeFunctions?.size ?? 0;
    if (edgeRouteCount > 0) {
      budget.consume('edgeFunctions', 'edge-routes', edgeRouteCount);
    }
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

    // basePath (if set) prefixes every routable URL on the deployed site.
    // Redirect sources/destinations declared by the framework are
    // basePath-relative; prefix them here so the CF Function matches the
    // actual request URIs CloudFront sees.
    const rawRedirects = manifest.redirects ?? [];
    const manifestRedirects = manifest.basePath
      ? rawRedirects.map((r) => ({
          ...r,
          source: prependBasePath(manifest.basePath, r.source),
          destination: prependBasePath(manifest.basePath, r.destination),
        }))
      : rawRedirects;

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

    const viewerRequestFunction = this.createViewerRequestFunction(
      buildId,
      skewEnabled,
      manifestRedirects,
      manifest.basePath,
      { spaFallback: isSpaFallback, wwwRedirect: props.wwwRedirect },
    );
    // The viewer-request function rewrites every request to the new
    // build's `/builds/<buildId>/` prefix - gate its publish on the asset
    // uploads (see addBuildAssetDependency).
    this.buildIdFunctions.push(viewerRequestFunction);

    // ---- Skew protection viewer-response function ----
    const viewerResponseFunction = this.createViewerResponseFunction(
      buildId,
      skewMaxAge,
      skewEnabled,
    );

    // ---- Origins ----
    const s3Origin = S3BucketOrigin.withOriginAccessControl(bucket);

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

    if (ssrComputeName && props.computeFunctions) {
      // Target the warm `live` alias when provisioned concurrency is set;
      // otherwise the unqualified function ($LATEST). Without this, the
      // REST integration always hit $LATEST and provisioned instances on
      // the alias sat idle.
      const ssrFn =
        props.computeAliases?.get(ssrComputeName) ??
        props.computeFunctions.get(ssrComputeName)!;

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

      // REGIONAL: CloudFront is already in front; edge-optimized would
      // double-proxy and cap streaming idle timeout at 30s.
      const restApi = new RestApi(this, 'SsrRestApi', {
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
      const apiHostname = Fn.select(2, Fn.split('/', restApi.url));
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

    // ---- x-forwarded-host + redirect function (compute behaviors) ----
    // CloudFront strips the viewer's Host header when forwarding to Lambda Function
    // URL origins (ALL_VIEWER_EXCEPT_HOST_HEADER policy). OpenNext's converters use
    // x-forwarded-host to construct the public-facing URL for middleware rewrites and
    // image optimization fetches. Without it, URL construction uses the Function URL
    // domain which breaks path-only rewrites ("TypeError: Invalid URL").
    //
    // Same function also runs the manifest redirect table — a matching
    // redirect short-circuits the request before the Lambda is invoked.
    const forwardedHostFunction = hasCompute
      ? new CloudFrontFunction(this, 'ForwardedHostFunction', {
          code: FunctionCode.fromInline(
            generateForwardedHostAndRedirectFunctionCode(
              manifestRedirects,
              manifest.basePath,
            ),
          ),
          runtime: CLOUDFRONT_FUNCTION_RUNTIME,
          comment:
            manifestRedirects.length > 0
              ? `Forwarded-host + ${manifestRedirects.length} redirect rule(s)`
              : 'Copies Host header to x-forwarded-host for origin URL construction',
        })
      : undefined;

    // ---- Serialize CloudFront Function creation ----
    // The CloudFront CreateFunction API has a strict rate limit (~1 TPS).
    // Without explicit ordering, CloudFormation dispatches all CF Function
    // creates in parallel, causing "Rate exceeded" failures. Chain them
    // so each waits for the previous to finish.
    if (forwardedHostFunction) {
      forwardedHostFunction.node.addDependency(viewerRequestFunction);
    }
    if (viewerResponseFunction) {
      viewerResponseFunction.node.addDependency(
        forwardedHostFunction ?? viewerRequestFunction,
      );
    }

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
          queryStringBehavior: CacheQueryStringBehavior.all(),
          enableAcceptEncodingBrotli: true,
          enableAcceptEncodingGzip: true,
        })
      : undefined;

    // ---- Behavior helpers ----
    const makeStaticBehavior = (): BehaviorOptions => ({
      origin: s3Origin,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
      cachePolicy: CachePolicy.CACHING_OPTIMIZED,
      compress: true,
      responseHeadersPolicy: props.securityHeadersPolicy,
      functionAssociations: [
        {
          function: viewerRequestFunction,
          eventType: FunctionEventType.VIEWER_REQUEST,
        },
        ...(viewerResponseFunction
          ? [
              {
                function: viewerResponseFunction,
                eventType: FunctionEventType.VIEWER_RESPONSE,
              },
            ]
          : []),
      ],
    });

    const makeComputeBehavior = (origin?: IOrigin): BehaviorOptions => ({
      origin: origin ?? primaryOrigin!,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: AllowedMethods.ALLOW_ALL,
      // B21: honor origin Cache-Control. POST/PUT/DELETE are never
      // cached by CloudFront regardless of CachePolicy (HTTP spec).
      cachePolicy: ssrCachePolicy ?? CachePolicy.CACHING_DISABLED,
      compress: true,
      originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: props.securityHeadersPolicy,
      ...(edgeLambdas ? { edgeLambdas } : {}),
      functionAssociations: [
        ...(forwardedHostFunction
          ? [
              {
                function: forwardedHostFunction,
                eventType: FunctionEventType.VIEWER_REQUEST,
              },
            ]
          : []),
        ...(viewerResponseFunction
          ? [
              {
                function: viewerResponseFunction,
                eventType: FunctionEventType.VIEWER_RESPONSE,
              },
            ]
          : []),
      ],
    });

    /**
     * Cache behavior for an OpenNext edge route (Lambda@Edge owns the
     * response). The S3 origin is just a placeholder — CloudFront
     * associates the function on origin-request and the function returns
     * the response itself, so origin storage is never read.
     *
     * Uses the same `ssrCachePolicy` as the regional SSR behavior so
     * edge routes can opt into CloudFront caching by emitting
     * `Cache-Control: s-maxage=N` from the function response — the same
     * mechanism Vercel uses for its Edge Functions. The cache policy's
     * `defaultTtl: 0` means routes that don't set `Cache-Control` (the
     * default for auth/geo/personalization routes) still skip CloudFront
     * caching and invoke Lambda@Edge on every request.
     *
     * Auth-bearing edge routes MUST emit `Cache-Control: private` (or
     * `no-store`) to opt out — see `ssrCachePolicy.cookieBehavior:none`.
     * Cookies are not in the cache key; without an explicit private
     * directive, an authenticated response could be served to other
     * users.
     */
    const makeEdgeRouteBehavior = (edgeVersion: IVersion): BehaviorOptions => ({
      origin: s3Origin,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy: ssrCachePolicy ?? CachePolicy.CACHING_DISABLED,
      compress: true,
      originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: props.securityHeadersPolicy,
      edgeLambdas: [
        {
          functionVersion: edgeVersion,
          eventType: LambdaEdgeEventType.ORIGIN_REQUEST,
          includeBody: true,
        },
      ],
    });

    // ---- Route → behavior mapping ----
    const additionalBehaviors: Record<string, BehaviorOptions> = {};

    // Separate catch-all from specific routes
    const catchAllRoute = manifest.routes.find(
      (r) => r.pattern === '/*' || r.pattern === '*',
    );
    const specificRoutes = manifest.routes
      .filter((r) => r.pattern !== '/*' && r.pattern !== '*')
      // CloudFront evaluates cache behaviors top-to-bottom, first-match-wins
      // (no longest-prefix preference). When the manifest mixes a literal
      // pattern (`/api/edge/b`) with a wildcard from a sibling dynamic route
      // (`/api/edge/*`, expanded from Next's `[slug]`), the wildcard
      // shadows the literal if it's emitted first. Sort by descending
      // specificity so literals always come before wildcards. Same key as
      // CDK's own behavior ordering: count wildcards, then prefer longer
      // patterns within the same wildcard count.
      .sort(
        (a, b) => routeSpecificity(b.pattern) - routeSpecificity(a.pattern),
      );

    // NOTE: the CloudFront behavior-count limit is NOT validated here.
    // `specificRoutes.length` under-counts the real total — each static
    // route also spawns a derived bare behavior (`deriveBareStaticPattern`),
    // and header / assetPrefix / `/builds/*` behaviors are added later. The
    // authoritative check runs after `additionalBehaviors` is fully built
    // (just before the Distribution is created), so it counts what actually
    // ships. See the `TooManyRoutesError` throw below.

    const basePath = manifest.basePath;
    const immutableGlobs = manifest.staticAssets.immutablePaths ?? [];

    // Prerendered-page behaviors, recorded in route order (descending
    // specificity) so the budget-relief passes below can act on the
    // lowest-priority ones first. Each entry maps the subtree pattern to its
    // derived bare pattern (if any) so both move together. Used two ways:
    //   - compute deploys: DEMOTE to the SSR runtime (Phase 2).
    //   - static-only deploys: GROUP co-located siblings under one
    //     `<parent>/*` behavior (Phase 3) — there's no runtime to demote to.
    const pageBehaviors: { subtree: string; bare: string | null }[] = [];

    for (const route of specificRoutes) {
      const isStatic = route.target === 'static' || route.target === 's3';
      const cfPattern = prependBasePath(
        basePath,
        normalizePatternForCloudFront(route.pattern),
      );

      if (isStatic) {
        additionalBehaviors[cfPattern] = makeStaticBehavior();

        // CloudFront path patterns are not "match either trailing-slash or
        // bare" — `/about/*` matches `/about/x` but NOT bare `/about`.
        // For prerendered routes that emit `<name>/index.html` the bare
        // path falls through to the SSR Lambda, which silently re-renders
        // every request and ruins the SSG semantics (also costing Lambda
        // invocations the user didn't sign up for).
        //
        // When we see a static `<name>/*` pattern, also emit a behavior
        // for the bare `<name>` path so both forms hit S3. The S3 origin
        // (with index document set on the bucket) resolves the bare path
        // to `<name>/index.html` automatically.
        const barePattern = deriveBareStaticPattern(cfPattern);
        if (barePattern && !(barePattern in additionalBehaviors)) {
          additionalBehaviors[barePattern] = makeStaticBehavior();
        }

        // Record prerendered pages (not hashed-asset prefixes) for the
        // budget-relief passes. The compute-vs-static decision of HOW to
        // relieve pressure is made later; here we just identify candidates.
        if (isDemotablePageRoute(route, cfPattern, immutableGlobs, basePath)) {
          pageBehaviors.push({ subtree: cfPattern, bare: barePattern });
        }
      } else {
        // OpenNext edge routes (`runtime = 'edge'`) come through as compute
        // names in `routeEdgeFunctions`. The Lambda@Edge function generates
        // the response itself — we still need a CloudFront origin (S3 here)
        // so the behavior is well-formed; CloudFront associates the edge
        // function on origin-request and never reaches origin storage when
        // the function returns a response.
        const edgeVersion = props.routeEdgeFunctions?.get(route.target);
        if (edgeVersion) {
          additionalBehaviors[cfPattern] = makeEdgeRouteBehavior(edgeVersion);
        } else {
          // Look up per-compute origin, fall back to primary
          const targetOrigin =
            computeOrigins.get(route.target) ?? primaryOrigin;
          if (targetOrigin) {
            additionalBehaviors[cfPattern] = makeComputeBehavior(targetOrigin);
          } else {
            additionalBehaviors[cfPattern] = makeStaticBehavior();
          }
        }
      }
    }

    // ---- assetPrefix behavior (P2.7) ----
    // When the framework's build emits asset URLs under a prefix
    // (Next.js `assetPrefix: '/shop-static'`), the non-prefixed
    // `/_next/static/*` behavior won't match. A naive
    // implementation emits four separate prefixed behaviors
    // (`/<prefix>/_next/static/*`, `/_next/image*`, `/_next/data/*`,
    // `/_next/*`) — each one consuming a slot of the CloudFront
    // 24-additional-behavior budget. That scales poorly: the hosting
    // construct already provisions ~6-10 base behaviors for SSR /
    // image-opt / static / cache routes, so dedicating four more to
    // a single config knob is wasteful.
    //
    // We collapse to a single `/<prefix>/*` behavior backed by a
    // smarter strip function. The function inspects the URI tail
    // after stripping the prefix and routes the request the same way
    // CloudFront's first-match-wins behavior matching would have
    // done — but in code, in O(1), at the edge — saving 3 behaviors
    // per assetPrefix.
    const assetPrefix = manifest.assetPrefix;
    if (assetPrefix) {
      const stripFunction = new CloudFrontFunction(
        this,
        'AssetPrefixStripFunction',
        {
          code: FunctionCode.fromInline(
            generateAssetPrefixStripFunctionCode(buildId, assetPrefix),
          ),
          runtime: CLOUDFRONT_FUNCTION_RUNTIME,
          comment: `Strip Next.js assetPrefix=${assetPrefix} before S3 lookup`,
        },
      );
      // Chain to the last CF Function to stay within rate limits.
      stripFunction.node.addDependency(
        viewerResponseFunction ??
          forwardedHostFunction ??
          viewerRequestFunction,
      );
      // Also bakes in the buildId (`/builds/<buildId>/`), so it must wait
      // for the asset uploads before publishing - same as the viewer-request
      // function above.
      this.buildIdFunctions.push(stripFunction);
      const prefixedStaticBehavior: BehaviorOptions = {
        origin: s3Origin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        responseHeadersPolicy: props.securityHeadersPolicy,
        functionAssociations: [
          {
            function: stripFunction,
            eventType: FunctionEventType.VIEWER_REQUEST,
          },
        ],
      };
      // Note: when both basePath and assetPrefix are absolute (leading
      // `/`), Next.js emits asset URLs as `<assetPrefix>/...` WITHOUT
      // prepending basePath — so the CloudFront behavior must match
      // the bare assetPrefix path, NOT the basePath-prefixed one.
      // One catch-all under the prefix; the strip function handles
      // _next/static, _next/image, _next/data, and the open _next/*
      // case uniformly.
      const catchAllPrefixedPattern = `${assetPrefix}/*`;
      if (!(catchAllPrefixedPattern in additionalBehaviors)) {
        additionalBehaviors[catchAllPrefixedPattern] = prefixedStaticBehavior;
      }
    }

    // ---- Default behavior (from catch-all route) ----
    const defaultIsCompute =
      catchAllRoute &&
      catchAllRoute.target !== 'static' &&
      catchAllRoute.target !== 's3' &&
      hasCompute;

    let defaultBehavior = defaultIsCompute
      ? makeComputeBehavior(
          computeOrigins.get(catchAllRoute!.target) ?? primaryOrigin,
        )
      : makeStaticBehavior();

    // ---- Per-pattern custom response headers (manifest.headers[]) ----
    // Each entry in manifest.headers[] declares a (source, headers) pair.
    // For each, we construct a per-pattern ResponseHeadersPolicy that
    // bundles the security headers + the custom headers, and attach it
    // to the matching behavior. If the source pattern has no behavior
    // yet (i.e. it's a static path the user wants to set headers on
    // without otherwise routing), we synthesize a static behavior so
    // the policy has something to attach to.
    const manifestHeaders = manifest.headers ?? [];
    if (manifestHeaders.length > 0) {
      // Dedupe by header-content fingerprint. Many `publicAssets[]`
      // entries from Nuxt produce *identical* Cache-Control rules — we
      // share one ResponseHeadersPolicy across all of them so the
      // account-wide CloudFront ResponseHeadersPolicy quota (default 20
      // per account, max 200) doesn't get burned on duplicates.
      //
      // The fingerprint includes the SECURITY-HEADER inputs the policy
      // body will end up containing (CSP value, since other security
      // header values are constants today). Without that, toggling
      // `cdn.contentSecurityPolicy` between deploys produced new
      // construct IDs even when the user's `headers[]` content hadn't
      // changed — burning quota on every CSP edit (P2.5). With it,
      // identical (customHeaders × securityHeaderInputs) tuples dedup
      // across deploys.
      const policyByFingerprint = new Map<string, ResponseHeadersPolicy>();
      const securityHeaderFingerprint = props.contentSecurityPolicy ?? '';
      const fingerprint = (headers: Record<string, string>): string => {
        const customPart = Object.keys(headers)
          .sort()
          .map((k) => `${k}=${headers[k]}`)
          .join('\n');
        return `csp=${securityHeaderFingerprint}\n--\n${customPart}`;
      };

      // Construct ID uses the first 8 hex chars of a SHA-256 over the
      // fingerprint. Why a stable hash instead of a counter (0/1/2/...):
      // a positional counter changes whenever the iteration order of
      // `manifest.headers[]` changes (e.g. user reorders publicAssets[]
      // in nuxt.config.ts). That makes CDK think each redeploy needs to
      // create new policies + delete the old ones — which churns the
      // account-wide ResponseHeadersPolicy quota and risks leaking
      // stale policies under failed rollbacks (B20). A content-derived
      // ID makes each unique header-set get the same construct ID
      // forever, so a redeploy with the same content is a no-op.
      const idForHeaders = (headers: Record<string, string>): string => {
        const fp = fingerprint(headers);
        return `CustomHeadersPolicy${createHash('sha256')
          .update(fp)
          .digest('hex')
          .slice(0, 8)}`;
      };

      const getOrCreatePolicy = (
        headers: Record<string, string>,
      ): ResponseHeadersPolicy => {
        const fp = fingerprint(headers);
        const existing = policyByFingerprint.get(fp);
        if (existing) return existing;
        const policy = createCustomHeadersPolicy(
          this,
          idForHeaders(headers),
          headers,
          { contentSecurityPolicy: props.contentSecurityPolicy },
        );
        policyByFingerprint.set(fp, policy);
        // Each DISTINCT (deduped) per-pattern policy draws from the account-wide
        // "Response headers policies per AWS account" quota. Track it so the
        // budget can flag a distribution that alone would exhaust the account
        // limit — previously this quota was unguarded and blew up opaquely at
        // deploy time.
        budget.consume('headerPolicies', `policy:${fp}`);
        return policy;
      };

      const overrideBehaviorPolicy = (
        target: BehaviorOptions,
        headers: Record<string, string>,
      ): BehaviorOptions => ({
        ...target,
        responseHeadersPolicy: getOrCreatePolicy(headers),
      });

      // B22: when no behavior exists for a header pattern yet, the synthesized
      // behavior must match how the catch-all would have served the same
      // request. This is only reached for STATIC-only deploys — when the
      // manifest declares compute, header-only patterns delegate to the SSR
      // runtime instead of getting a (redundant) dedicated behavior (see the
      // `hasCompute` early-continue in the header loop below). So a static
      // behavior is always the correct origin choice here.
      const synthesizeBehaviorForHeaderPattern = (): BehaviorOptions =>
        makeStaticBehavior();

      for (const entry of manifestHeaders) {
        const cfPattern = normalizePatternForCloudFront(entry.source);
        if (cfPattern === '/*' || cfPattern === '*') {
          // Header rule applies to the catch-all → patch defaultBehavior
          defaultBehavior = overrideBehaviorPolicy(
            defaultBehavior,
            entry.headers,
          );
        } else if (additionalBehaviors[cfPattern]) {
          // Existing behavior — override its policy
          additionalBehaviors[cfPattern] = overrideBehaviorPolicy(
            additionalBehaviors[cfPattern],
            entry.headers,
          );
        } else {
          // No behavior exists for this header-only pattern yet. Whether we
          // synthesize a dedicated edge behavior for it depends on whether a
          // runtime sits in the request path:
          //
          //   - WITH compute: a synthesized behavior would point at the SAME
          //     SSR Lambda the catch-all (defaultBehavior) already routes this
          //     path to — same origin, same policy choice.
          //     Every manifest.headers entry originates from the framework's
          //     own config (Next headers() / Nitro routeRules), and the
          //     framework server emits those headers at runtime from its
          //     bundled manifest; CloudFront caches the Lambda response
          //     INCLUDING those headers. So a dedicated edge behavior is pure
          //     redundancy — it burns one of the scarce ~25 behavior slots to
          //     re-assert a header the origin already sets. Delegate to the
          //     runtime: don't wire a behavior, let the request fall through
          //     to the catch-all. This also keeps header rules from competing
          //     with genuinely-needed route behaviors for the behavior cap.
          //   - STATIC-ONLY: S3 serves the bytes directly; there is no runtime
          //     to emit the header, so a dedicated behavior is the ONLY way to
          //     apply it. If wiring it would exceed the CloudFront behavior
          //     cap, a SECURITY header (CSP/HSTS/X-Frame/…) silently vanishing
          //     looks like a successful deploy but ships an unprotected site —
          //     fail the build. A cosmetic header is acceptable to lose; warn.
          if (hasCompute) {
            process.stdout.write(
              `ℹ️  Header rule for "${entry.source}" is applied at the ` +
                `framework server runtime (the SSR origin already emits it); ` +
                `skipping a redundant CloudFront behavior.\n`,
            );
            continue;
          }
          if (
            Object.keys(additionalBehaviors).length >= maxAdditionalBehaviors
          ) {
            if (containsSecurityHeader(entry.headers)) {
              throw new HostingError('SecurityHeaderDroppedError', {
                message:
                  `Cannot apply the header rule for "${entry.source}": the ` +
                  `distribution is already at the CloudFront cache-behavior ` +
                  `cap (${maxAdditionalBehaviors}), and this rule sets a ` +
                  `security header (${Object.keys(entry.headers)
                    .filter((h) => containsSecurityHeader({ [h]: '' }))
                    .join(', ')}). This is a static-only deploy, so there is ` +
                  `no runtime to fall back to and dropping it would silently ` +
                  `ship an unprotected response.`,
                resolution:
                  'Reduce the number of routed paths / per-pattern header ' +
                  'rules so the distribution stays under the behavior cap, ' +
                  'or apply this security header globally (e.g. via the ' +
                  'default security-headers policy / contentSecurityPolicy) ' +
                  'instead of a per-pattern rule.',
              });
            }
            process.stderr.write(
              `⚠️  Skipping custom headers for "${entry.source}" — would exceed CloudFront behavior cap.\n`,
            );
            continue;
          }
          additionalBehaviors[cfPattern] = overrideBehaviorPolicy(
            synthesizeBehaviorForHeaderPattern(),
            entry.headers,
          );
        }
      }
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

    // ---- Error-page behavior (B22) ----
    // CloudFront custom error responses fetch the configured
    // responsePagePath from the behavior matching that path. Error pages
    // live at /builds/<buildId>/404.html (or _error.html) in S3. Without
    // an explicit behavior, the path falls to the default (compute)
    // behavior and the Lambda can't serve the file — causing CloudFront
    // to fall back to the original error. Add a direct-to-S3 behavior
    // for /builds/* so error page fetches resolve correctly.
    if (errorResponses.length > 0 && hasCompute) {
      additionalBehaviors['/builds/*'] = {
        origin: s3Origin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        responseHeadersPolicy: props.securityHeadersPolicy,
      };
    }

    // ---- Budget relief: grouping (static) then demotion (compute) ----
    // Both passes only fire when the distribution would exceed its
    // cache-behavior budget, and both only ever touch prerendered-PAGE
    // behaviors (hashed-asset prefixes, edge routes, image-opt and non-default
    // compute are never in `pageBehaviors`, so they are never collapsed or
    // demoted).

    // Phase 3 — grouping (static-only). Collapse co-located sibling pages that
    // share a parent path into one `<parent>/*` behavior. Safe ONLY when the
    // catch-all is itself S3 (no compute): then a path under `<parent>/` —
    // known or not — resolves through S3 whether it hits the grouped behavior
    // or the catch-all, so the merge is lossless (same origin, same policy,
    // fewer behaviors). Under compute it would be UNSAFE (an unknown
    // `<parent>/x` the SSR Lambda renders dynamically would instead be sent to
    // S3 and 404), so compute uses demotion below rather than grouping.
    if (
      !hasCompute &&
      Object.keys(additionalBehaviors).length > maxAdditionalBehaviors &&
      pageBehaviors.length > 0
    ) {
      groupSiblingPageBehaviors(
        additionalBehaviors,
        pageBehaviors,
        maxAdditionalBehaviors,
        makeStaticBehavior,
      );
    }

    // Phase 2 — demotion (compute). Drop the lowest-priority prerendered-page
    // behaviors (subtree + derived bare) until the distribution fits, rather
    // than failing the build. A demoted page still serves correctly — its bare
    // path falls through to the catch-all SSR Lambda, which re-renders it on
    // demand; only the S3 fast-path for that page (and its sibling subtree
    // assets) is lost. Demotion is LIFO over the specificity-sorted list, so it
    // sheds the least-specific pages first and keeps deeper routes on the edge.
    // This makes allocation deterministic — which pages survive no longer
    // depends on incidental iteration order.
    if (
      hasCompute &&
      Object.keys(additionalBehaviors).length > maxAdditionalBehaviors &&
      pageBehaviors.length > 0
    ) {
      let demotedCount = 0;
      let victim = pageBehaviors.pop();
      while (
        victim &&
        Object.keys(additionalBehaviors).length > maxAdditionalBehaviors
      ) {
        delete additionalBehaviors[victim.subtree];
        if (victim.bare) delete additionalBehaviors[victim.bare];
        demotedCount++;
        victim = pageBehaviors.pop();
      }
      process.stdout.write(
        `ℹ️  Hosting: ${demotedCount} prerendered page${demotedCount === 1 ? '' : 's'} ` +
          `exceeded the CloudFront behavior budget (${maxAdditionalBehaviors}); ` +
          `serving ${demotedCount === 1 ? 'it' : 'them'} from the SSR runtime instead ` +
          `of a dedicated edge behavior. Raise \`quotas.cacheBehaviors\` if AWS has ` +
          `granted your account a higher limit.\n`,
      );
    }

    // ---- Authoritative CloudFront behavior-count check ----
    // Count the REAL additional behaviors now that every source has
    // contributed: per-route static/compute/edge behaviors, the derived bare
    // static paths, assetPrefix, custom-header behaviors, and `/builds/*`.
    // This is the single enforcement point for both adapters — neither the
    // Next/Astro nor the Nitro adapter caps prerendered-page routes itself;
    // they emit one `/<page>/*` route per page and rely on this check to fail
    // loudly. After the degradation pass above, reaching this throw means the
    // overflow is NOT demotable pages (it's hashed assets / compute / header
    // rules / edge routes, or a static-only deploy with no runtime fallback).
    const additionalBehaviorCount = Object.keys(additionalBehaviors).length;
    if (additionalBehaviorCount > maxAdditionalBehaviors) {
      throw new HostingError('TooManyRoutesError', {
        message: `This distribution would create ${additionalBehaviorCount} additional CloudFront cache behaviors, but the maximum is ${maxAdditionalBehaviors} (CloudFront allows ${maxAdditionalBehaviors + 1} including the default). Each prerendered page consumes up to 2 behaviors (the \`/page/*\` subtree plus a derived bare \`/page\`).`,
        resolution:
          'Reduce the number of distinctly-routed prerendered pages or custom-header/assetPrefix patterns. Pages that are not given a dedicated behavior still serve correctly through the SSR Lambda — consider prerendering fewer top-level routes, or grouping pages under a shared path prefix so one `/<prefix>/*` behavior covers them. If AWS has granted your account a higher "Cache behaviors per distribution" quota, raise the `quotas.cacheBehaviors` hosting prop to match.',
      });
    }

    // Enforce the remaining tracked quotas (currently the account-wide
    // response-headers-policy count). The behavior quota is enforced by the
    // richer TooManyRoutesError above; this catches the others.
    budget.assertWithinLimits();

    // ---- Distribution ----
    this.distribution = new Distribution(this, 'HostingDistribution', {
      defaultBehavior,
      additionalBehaviors:
        additionalBehaviorCount > 0 ? additionalBehaviors : undefined,
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

    // ---- Self-enforcing atomic-deploy guard ----
    // The build-id CloudFront functions rewrite every request to
    // `/builds/<buildId>/...`. If they publish before that build's assets are
    // uploaded to the OAC-protected bucket, new/cookieless visitors get 403
    // for the whole deploy window. `addBuildAssetDependency` wires each asset
    // BucketDeployment as a dependency so CloudFormation uploads first. This
    // validation fails synth if build-id functions exist alongside asset
    // deployments but NONE were registered - i.e. the wiring loop in the
    // hosting construct was removed/broken, silently re-opening the 403
    // window. It runs at synth, after all `addBuildAssetDependency` calls.
    this.node.addValidation({
      validate: (): string[] => {
        // No build-id functions -> nothing to gate.
        if (this.buildIdFunctions.length === 0) return [];
        // At least one asset deployment was wired -> invariant holds.
        if (this.buildAssetDependencyCount > 0) return [];
        // Nothing was wired. Only fail if asset BucketDeployments actually
        // exist in this stack; a standalone CdnConstruct with no assets (or a
        // hypothetical asset-less deploy) is legitimate and must not
        // false-positive.
        const hasAssetDeployments = Stack.of(this)
          .node.findAll()
          .some((c) => c instanceof BucketDeployment);
        if (!hasAssetDeployments) return [];
        return [
          `CdnConstruct '${this.node.path}' has ${this.buildIdFunctions.length} ` +
            'build-id CloudFront function(s) that rewrite requests to ' +
            "'/builds/<buildId>/...', but no asset BucketDeployment was " +
            'registered via addBuildAssetDependency(). The build-id cutover ' +
            'would publish before the new build assets are uploaded, ' +
            'returning 403 Access Denied to new/cookieless visitors for the ' +
            'entire deploy window. An asset BucketDeployment was likely added ' +
            'without calling cdn.addBuildAssetDependency(deployment).',
        ];
      },
    });
  }

  /**
   * Register a dependency that must finish before the build-id cutover.
   *
   * The viewer-request (and Next.js assetPrefix-strip) CloudFront Functions
   * bake the deploy's buildId into the request rewrite, sending traffic to
   * `/builds/<buildId>/...` in the OAC-protected S3 bucket. If those
   * functions publish before the new build's assets land at that prefix,
   * new/cookieless visitors get 403 Access Denied for the duration of the
   * deploy window (returning visitors with a `__dpl` skew cookie keep hitting
   * the previous build and are unaffected).
   *
   * The hosting construct calls this with every asset `BucketDeployment` for
   * the new build, so CloudFormation uploads the assets first and only then
   * publishes the functions (and the distribution that references them).
   * This makes redeploys atomic from a new visitor's perspective.
   */
  addBuildAssetDependency(dependency: IDependable): void {
    for (const fn of this.buildIdFunctions) {
      fn.node.addDependency(dependency);
    }
    this.buildAssetDependencyCount += 1;
  }

  /**
   * Creates the viewer-request CloudFront Function.
   * When skew protection is enabled, reads the `__dpl` cookie to route users
   * to their pinned build. Otherwise uses a combined build-id rewrite + redirect function.
   * Optionally prepends www redirect logic when `wwwRedirect` is configured.
   */
  private createViewerRequestFunction(
    buildId: string,
    skewEnabled: boolean,
    redirects: Redirect[],
    basePath?: string,
    options?: {
      spaFallback?: boolean;
      wwwRedirect?: 'toApex' | 'toWww' | 'none';
    },
  ): CloudFrontFunction {
    const wwwRedirectSnippet = generateWwwRedirectSnippet(options?.wwwRedirect);

    if (skewEnabled) {
      return new CloudFrontFunction(this, 'SkewProtectionRequestFunction', {
        code: FunctionCode.fromInline(
          injectWwwRedirect(
            generateSkewProtectionViewerRequestCode(buildId, redirects, {
              spaFallback: options?.spaFallback,
              basePath,
            }),
            wwwRedirectSnippet,
          ),
        ),
        runtime: CLOUDFRONT_FUNCTION_RUNTIME,
        comment:
          redirects.length > 0
            ? `Skew protection: cookie-based routing + ${redirects.length} redirect rule(s)`
            : `Skew protection: routes requests to build from cookie or current build ${buildId}`,
      });
    }
    return new CloudFrontFunction(this, 'BuildIdRewriteFunction', {
      code: FunctionCode.fromInline(
        injectWwwRedirect(
          generateBuildIdAndRedirectFunctionCode(buildId, redirects, basePath, {
            spaFallback: options?.spaFallback,
          }),
          wwwRedirectSnippet,
        ),
      ),
      runtime: CLOUDFRONT_FUNCTION_RUNTIME,
      comment:
        redirects.length > 0
          ? `Build-id rewrite + ${redirects.length} redirect rule(s)`
          : `Rewrites request URIs to include build ID prefix: builds/${buildId}/`,
    });
  }

  /**
   * Creates the viewer-response CloudFront Function for skew protection.
   * Sets the `__dpl` cookie on HTML responses to pin the user's session.
   * Returns `undefined` when skew protection is disabled.
   */
  private createViewerResponseFunction(
    buildId: string,
    maxAge: number,
    skewEnabled: boolean,
  ): CloudFrontFunction | undefined {
    if (!skewEnabled) {
      return undefined;
    }
    return new CloudFrontFunction(this, 'SkewProtectionResponseFunction', {
      code: FunctionCode.fromInline(
        generateSkewProtectionViewerResponseCode(buildId, maxAge),
      ),
      runtime: CLOUDFRONT_FUNCTION_RUNTIME,
      comment: `Skew protection: sets __dpl cookie to ${buildId} on HTML responses`,
    });
  }
}

/** Characters that indicate regex syntax — not valid in CloudFront path patterns. */
const REGEX_INDICATORS = /[\\^${}()|[\]+?]/;

/**
 * Normalize a route pattern into a CloudFront-compatible path pattern.
 *
 * CloudFront supports only simple glob patterns with `*` and `?` wildcards.
 * Regex or complex glob syntax is not supported and will cause deployment failures.
 */
const normalizePatternForCloudFront = (pattern: string): string => {
  if (REGEX_INDICATORS.test(pattern)) {
    throw new HostingError('InvalidRoutePatternError', {
      message: `Route pattern '${pattern}' contains regex syntax which CloudFront does not support.`,
      resolution:
        'CloudFront path patterns only support * (match any) and ? (match single char). ' +
        'Convert regex patterns to glob-style (e.g., /api/* instead of /api/(.*))',
    });
  }

  // Ensure pattern starts with /
  if (!pattern.startsWith('/')) {
    return `/${pattern}`;
  }
  return pattern;
};

/**
 * Score a route pattern's specificity. Higher score = more specific = should
 * be evaluated first by CloudFront (which is first-match-wins on the order
 * we emit cache behaviors).
 *
 * Approach:
 *   - Primary axis: count of literal (non-wildcard) path segments. A pattern
 *     with more literal segments constrains more of the URL path and is
 *     therefore more specific. `/api/*\/data/*` (2 literal segments)
 *     constrains more than `/*` (0 literal segments) regardless of wildcard
 *     count.
 *   - Tiebreaker: pattern length. Within the same literal-segment count,
 *     longer patterns generally constrain more bytes.
 *
 * Why not "fewer wildcards wins": that ordering ranks `/*` (1 wildcard)
 * above `/api/*\/data/*` (2 wildcards) even though the latter is strictly
 * more constraining. Literal segments are the right primary axis.
 *
 * Examples (highest to lowest):
 *   `/api/edge/catch/*`  → 3 literal segments, length 17 → 3_017
 *   `/api/edge/json`     → 3 literal segments, length 14 → 3_014
 *   `/api/edge/b`        → 3 literal segments, length 11 → 3_011
 *   `/api/*\/data/*`     → 2 literal segments, length 13 → 2_013
 *   `/api/edge/*`        → 2 literal segments, length 11 → 2_011
 *   `/_next/*`           → 1 literal segment,  length  8 → 1_008
 *   `/*`                 → 0 literal segments, length  2 →     2
 */
const routeSpecificity = (pattern: string): number => {
  const literalSegments = pattern
    .split('/')
    .filter((s) => s !== '' && s !== '*').length;
  return literalSegments * 1000 + pattern.length;
};

/**
 * For a static-route pattern that ends with `/*`, return the bare-path
 * variant so the route can be reached without a trailing slash.
 *
 * `/about/*` → `/about`
 * `/posts/2024/*` → `/posts/2024`
 *
 * Returns `null` for patterns that are not a simple `<name>/*` shape
 * (catch-alls, root patterns, multi-wildcard, etc.) — those don't have
 * a meaningful bare form, or the parent pattern is already covered by
 * other behaviors.
 *
 * Why this is needed: CloudFront path patterns don't have a "match
 * either bare or with-slash" wildcard. `/about/*` matches `/about/foo`
 * but NOT bare `/about`. Without an explicit bare-path behavior, the
 * bare form falls through to the SSR Lambda — breaking SSG semantics
 * (timestamp drift, every request is a Lambda invocation).
 */
const deriveBareStaticPattern = (pattern: string): string | null => {
  if (!pattern.endsWith('/*')) return null;
  const bare = pattern.slice(0, -2);
  // Don't emit `/` (would be the default behavior, not an additional one)
  // or anything containing additional wildcards (no useful bare form).
  if (bare === '' || bare === '/' || bare.includes('*')) return null;
  return bare;
};

/**
 * Test whether a route pattern matches one of the `immutablePaths` globs the
 * adapter declared (e.g. `_next/static/*`, `_nuxt/*`, `_astro/*`). Those
 * globs name the framework's HASHED-asset directories — files that live in S3
 * only, never in the SSR Lambda bundle. A behavior serving such a path must
 * NOT be demoted to the catch-all (the Lambda can't serve the bytes).
 *
 * Matching is intentionally simple: globs are anchored prefixes ending in
 * `/*` or `*`. We compare on the leading literal segment(s), basePath-aware.
 */
const matchesImmutableGlob = (
  pattern: string,
  immutableGlobs: string[],
  basePath?: string,
): boolean => {
  // Normalize both sides to a leading-slash, no-trailing-wildcard prefix.
  const stripWildcard = (p: string): string =>
    p.replace(/\/?\*+$/, '').replace(/^\/+/, '');
  const routeKey = stripWildcard(
    basePath && pattern.startsWith(basePath)
      ? pattern.slice(basePath.length)
      : pattern,
  );
  return immutableGlobs.some((glob) => {
    const globKey = stripWildcard(glob);
    return routeKey === globKey || routeKey.startsWith(`${globKey}/`);
  });
};

/**
 * Classify a static route as a "prerendered page" — i.e. one that is SAFE to
 * demote (drop its dedicated CloudFront behavior and let the bare path fall
 * through to the catch-all SSR Lambda, which re-renders the page on demand).
 *
 * A static route is demote-safe ONLY when ALL hold:
 *   - it targets S3 (`static`/`s3`),
 *   - it is NOT a hashed-asset prefix (would 404 from the Lambda — see
 *     {@link matchesImmutableGlob}),
 *   - it is a simple `<name>/*` subtree (the shape the adapters emit for
 *     prerendered pages and the only shape with a useful bare form).
 *
 * Edge routes, image-opt, and non-default compute targets are never static,
 * so they are excluded by the `target` check alone.
 */
const isDemotablePageRoute = (
  route: { pattern: string; target: string },
  cfPattern: string,
  immutableGlobs: string[],
  basePath?: string,
): boolean => {
  const isStatic = route.target === 'static' || route.target === 's3';
  if (!isStatic) return false;
  if (deriveBareStaticPattern(cfPattern) === null) return false; // not a <name>/* subtree
  if (matchesImmutableGlob(cfPattern, immutableGlobs, basePath)) return false;
  return true;
};

/**
 * Static-only budget relief: collapse co-located sibling prerendered-page
 * behaviors that share a parent path segment into a single `<parent>/*`
 * behavior, until the distribution fits within `maxAdditional` behaviors (or
 * no further grouping helps).
 *
 * Safety: callers must invoke this ONLY for static-only deploys, where the
 * catch-all is itself S3. There, a request under `<parent>/` resolves through
 * S3 whether it matches the grouped behavior or falls to the catch-all, so the
 * merge is lossless. (Under compute, an unknown `<parent>/x` the SSR Lambda
 * would render dynamically must NOT be redirected to S3 — hence compute uses
 * demotion, not grouping.)
 *
 * Grouping a parent with N child page-behaviors (each contributing a subtree
 * pattern plus possibly a derived bare pattern) replaces all of them with ONE
 * `<parent>/*` behavior — a net saving of (total child behaviors − 1). Parents
 * are grouped largest-saving-first for deterministic, maximal relief.
 *
 * Mutates `additionalBehaviors` in place. Returns the number of parents grouped.
 */
const groupSiblingPageBehaviors = (
  additionalBehaviors: Record<string, BehaviorOptions>,
  pageBehaviors: { subtree: string; bare: string | null }[],
  maxAdditional: number,
  makeStaticBehavior: () => BehaviorOptions,
): number => {
  // Bucket page behaviors by their immediate parent path (the prefix before
  // the last segment of the subtree pattern). `/docs/intro/*` → parent
  // `/docs`; `/blog/*` → parent `` (root), which we skip (grouping to `/*`
  // would shadow the catch-all).
  const parentOf = (subtree: string): string => {
    const bare = subtree.endsWith('/*') ? subtree.slice(0, -2) : subtree;
    const idx = bare.lastIndexOf('/');
    return idx > 0 ? bare.slice(0, idx) : '';
  };

  const byParent = new Map<
    string,
    { subtree: string; bare: string | null }[]
  >();
  for (const pb of pageBehaviors) {
    const parent = parentOf(pb.subtree);
    if (!parent) continue; // top-level page → no safe grouping target
    const list = byParent.get(parent) ?? [];
    list.push(pb);
    byParent.set(parent, list);
  }

  // Order parents by descending behavior-saving so the biggest reductions
  // happen first (and the result is deterministic regardless of Map order).
  const behaviorsFor = (group: { subtree: string; bare: string | null }[]) =>
    group.reduce(
      (n, pb) =>
        n +
        (pb.subtree in additionalBehaviors ? 1 : 0) +
        (pb.bare && pb.bare in additionalBehaviors ? 1 : 0),
      0,
    );
  const candidates = [...byParent.entries()]
    .map(([parent, group]) => ({ parent, group, saving: behaviorsFor(group) - 1 }))
    .filter((c) => c.saving > 0)
    .sort((a, b) => b.saving - a.saving || a.parent.localeCompare(b.parent));

  const childPatterns = new Set(
    pageBehaviors.flatMap((pb) => [pb.subtree, pb.bare].filter(Boolean) as string[]),
  );

  let grouped = 0;
  for (const { parent, group } of candidates) {
    if (Object.keys(additionalBehaviors).length <= maxAdditional) break;
    const groupPattern = `${parent}/*`;
    // Skip if `<parent>/*` is already a DIFFERENT behavior we don't own (e.g.
    // a per-pattern header rule or a hashed-asset prefix). Overwriting it
    // would silently change that path's origin/policy. Only safe to claim the
    // pattern when it's free or already one of the page children we're merging.
    if (
      groupPattern in additionalBehaviors &&
      !childPatterns.has(groupPattern)
    ) {
      continue;
    }
    // Remove every child subtree + derived bare behavior, then add the single
    // parent wildcard (reusing a child's static behavior shape).
    for (const pb of group) {
      delete additionalBehaviors[pb.subtree];
      if (pb.bare) delete additionalBehaviors[pb.bare];
    }
    additionalBehaviors[groupPattern] = makeStaticBehavior();
    grouped++;
  }

  if (grouped > 0) {
    process.stdout.write(
      `ℹ️  Hosting: grouped prerendered pages under ${grouped} shared ` +
        `\`<parent>/*\` behavior${grouped === 1 ? '' : 's'} to fit the CloudFront ` +
        `behavior budget (${maxAdditional}). Co-located pages now share one ` +
        `cache behavior; serving is unchanged (all resolve from S3).\n`,
    );
  }
  return grouped;
};

/**
 * Generate a JavaScript snippet that performs www ↔ apex redirection.
 * Returns empty string when wwwRedirect is 'none' or undefined.
 */
const generateWwwRedirectSnippet = (
  wwwRedirect?: 'toApex' | 'toWww' | 'none',
): string => {
  if (!wwwRedirect || wwwRedirect === 'none') return '';

  if (wwwRedirect === 'toApex') {
    return `  var __host = request.headers.host && request.headers.host.value;
  if (__host && __host.startsWith('www.')) {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://' + __host.substring(4) + request.uri + (request.querystring && Object.keys(request.querystring).length > 0 ? '?' + Object.keys(request.querystring).map(function(k) { var v = request.querystring[k]; return v.multiValue ? v.multiValue.map(function(mv) { return k + '=' + mv.value; }).join('&') : k + '=' + v.value; }).join('&') : '') } },
    };
  }
`;
  }

  // toWww
  return `  var __host = request.headers.host && request.headers.host.value;
  if (__host && !__host.startsWith('www.')) {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://www.' + __host + request.uri + (request.querystring && Object.keys(request.querystring).length > 0 ? '?' + Object.keys(request.querystring).map(function(k) { var v = request.querystring[k]; return v.multiValue ? v.multiValue.map(function(mv) { return k + '=' + mv.value; }).join('&') : k + '=' + v.value; }).join('&') : '') } },
    };
  }
`;
};

/**
 * Inject www redirect snippet into a CloudFront Function's handler body.
 * Inserts the snippet right after the `var request = event.request;` line.
 * Returns unmodified code when snippet is empty.
 */
const injectWwwRedirect = (functionCode: string, snippet: string): string => {
  if (!snippet) return functionCode;
  const marker = 'var request = event.request;';
  const idx = functionCode.indexOf(marker);
  if (idx === -1) return functionCode;
  const insertPos = idx + marker.length;
  return (
    functionCode.slice(0, insertPos) +
    '\n' +
    snippet +
    functionCode.slice(insertPos)
  );
};
