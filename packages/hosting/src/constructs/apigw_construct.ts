/**
 * API Gateway (HTTP API v2) front-door construct — a regional,
 * HTTPS-by-default, no-CloudFront door (the serverless sibling of the ALB door:
 * no VPC/NAT, scale-to-zero, pay-per-request).
 *
 * Serves the whole deploy from ONE HTTP API at the domain root (the auto
 * `$default` stage is rootless, so framework root-absolute URLs resolve):
 *   - static routes  → an asset-proxy Lambda integration (streams from the
 *     PRIVATE S3 bucket) — the API-Gateway analogue of CloudFront's S3+OAC.
 *   - `$default`      → the SSR server Lambda (or the asset proxy for a static
 *     site, which serves index.html on a miss for SPA fallback).
 *   - image routes    → the image-opt Lambda.
 *   - every API path (`/aws-blocks/*` plus the backend's raw routes) → an HTTP
 *     proxy integration straight to the backend API Gateway (same-origin; no
 *     forwarder Lambda needed, unlike ALB — HTTP API can proxy an external
 *     HTTPS URL natively).
 *
 * The app's redirects (a route per source → the asset proxy), per-pattern
 * response headers and error pages are applied by the asset proxy with the
 * CloudFront door's semantics; responses routed straight to the server, the
 * image function or the backend don't pass through it, which synth reports
 * (`@aws-blocks/hosting:DoorRulesNotApplied`).
 *
 * Not provided: no global edge cache, no per-route response headers on
 * server/API responses (synth names them), no skew protection, buffered SSR
 * only (an HTTP API can't stream). Unsupported settings are a type error in
 * `frontDoor.features` and a synth error through the deprecated top-level
 * props. API Gateway also imposes a ~29 s request timeout and a ~10 MB
 * payload / ~6 MB response cap. Stage-level config (TLS/domain, throttle)
 * applies to the whole API, not per route.
 */
import { Annotations, CfnOutput, Duration, Names, Stack } from 'aws-cdk-lib';
import { ApiMapping, DomainName, HttpApi, HttpMethod, type HttpRouteIntegrationBindOptions } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration, HttpUrlIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Code, Function as LambdaFunction, type IFunction } from 'aws-cdk-lib/aws-lambda';
import { AaaaRecord, ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { ApiGatewayv2DomainProperties } from 'aws-cdk-lib/aws-route53-targets';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { HostingPlan } from '../plan/types.js';
import { generateApiGwAssetProxyCode } from './apigw_asset_proxy.js';
import { imagePathPrefixes } from './asset_proxy_core.js';
import { warnRulesNotApplied } from './proxy_rules.js';
import { type ApiGwCustomDomain, resolveApiGwDomain } from './apigw_domain.js';
import {
  APIGW_DEFAULT_ROUTE_QUOTA,
  apiPathToRoutes,
  routableApiPaths,
  backendBaseUrl,
  DEFAULT_API_PATHS,
  globToProxyPath,
  hasInnerWildcard,
} from './apigw_routes.js';
import { assetProxyEnvironment } from './asset_proxy_core.js';
import { DEFAULT_NODE_RUNTIME } from './node_runtime.js';

export type ApiGatewayConstructProps = {
  plan: HostingPlan;
  bucket: IBucket;
  computeFunctions?: Map<string, IFunction>;
  serverComputeName?: string;
  imageComputeName?: string;
  /** Custom domain(s) — a regional cert + DomainName + API mapping + Route 53 alias. */
  domain?: ApiGwCustomDomain;
  /**
   * Every path pattern the single-compute (`'*'`) backend serves — the
   * `DoorInput.origins.api.paths`: `/aws-blocks/*` plus the backend's raw
   * routes. Each becomes a route proxied to the same path on the backend.
   * @default ['/aws-blocks/*']
   */
  apiPaths?: readonly string[];
  /**
   * The app's error pages, as object keys under the build prefix: the asset
   * proxy serves `notFound` (404) for a missing file and `serverError` (500)
   * when S3 fails.
   */
  errorPages?: { notFound?: string; serverError?: string };
  /**
   * Routes that a compute other than the server serves (e.g. a Next.js
   * `runtime: 'edge'` route built as a regional function), most-specific
   * first. Each pattern (basePath-prefixed) gets a route to that function.
   */
  computeRoutes?: readonly { pattern: string; computeName: string }[];
  /**
   * The deploy has no image function: route the framework image endpoints
   * (`/_next/image`, `/_ipx/*` and each of `pathPrefixes`, `/_image`, under
   * the basePath) to the asset
   * proxy, which serves the source image unoptimized. A remote source is
   * redirected to itself only when its host is in `hosts` (the app's image
   * allowlist); the proxy never fetches it.
   */
  imageFallback?: { hosts: readonly string[]; pathPrefixes?: readonly string[] };
};


/** The functions already allowed to be invoked by an API, by function. */
const invokePermitted = new WeakMap<IFunction, Set<string>>();

/**
 * A Lambda integration with one invoke permission per (function, API), for
 * every route and stage of the API (`<apiId>/*`). CDK's own API-scoped
 * permission (`scopePermissionToRoute: false`) wants three segments after the
 * API id (stage, method, path), which the `$default` route's source ARN
 * (`<apiId>/$default/$default`) doesn't have: API Gateway could not invoke the
 * catch-all (server-rendered pages, SPA deep links) and answered 500.
 *
 * @internal Framework-only.
 */
class ApiWideLambdaIntegration extends HttpLambdaIntegration {
  constructor(
    id: string,
    private readonly target: IFunction,
  ) {
    super(id, target);
  }

  protected override completeBind(options: HttpRouteIntegrationBindOptions): void {
    const api = options.route.httpApi;
    const apiKey = Names.nodeUniqueId(api.node);
    const permitted = invokePermitted.get(this.target) ?? new Set<string>();
    invokePermitted.set(this.target, permitted);
    if (permitted.has(apiKey)) return;
    permitted.add(apiKey);
    this.target.addPermission(`InvokeFromApi-${apiKey}`, {
      scope: options.scope,
      principal: new ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: Stack.of(api).formatArn({ service: 'execute-api', resource: api.apiId, resourceName: '*' }),
    });
  }
}

export class ApiGatewayConstruct extends Construct {
  readonly api: HttpApi;
  readonly url: string;
  /**
   * The static asset-proxy Lambda. Its `ASSET_KEY_PREFIX` environment names
   * the build, so it is the door's switch to a new build (its `cutover`).
   */
  readonly assetProxy: LambdaFunction;

  constructor(scope: Construct, id: string, props: ApiGatewayConstructProps) {
    super(scope, id);
    const { plan, bucket } = props;
    const buildId = plan.release.buildId;
    const compute = props.computeFunctions ?? new Map<string, IFunction>();
    const serverFn = props.serverComputeName ? compute.get(props.serverComputeName) : undefined;
    const imageFn = props.imageComputeName ? compute.get(props.imageComputeName) : undefined;

    // Asset-proxy Lambda (payload 2.0) → private S3.
    const stripPrefix = plan.policies.basePath ?? plan.policies.assetPrefix ?? '';
    const spaFallback = plan.policies.spaFallback && !serverFn;
    const assetProxy = new LambdaFunction(this, 'AssetProxy', {
      runtime: DEFAULT_NODE_RUNTIME,
      handler: 'index.handler',
      code: Code.fromInline(
        generateApiGwAssetProxyCode({
          stripPrefix,
          spaFallback,
          // The app's rules, applied as on the CloudFront door (see `asset_proxy_core.ts`).
          redirects: plan.routes.redirects,
          headers: plan.routes.headers,
          errorPages: props.errorPages,
          ...(props.imageFallback && !imageFn ? { imageFallback: props.imageFallback } : {}),
        }),
      ),
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: assetProxyEnvironment({ bucket, prefix: `builds/${buildId}` }),
    });
    bucket.grantRead(assetProxy);
    this.assetProxy = assetProxy;

    // One API-wide invoke permission per function, not one per route: a
    // per-route permission per path would grow each function's resource policy
    // toward Lambda's 20 KB limit. The trust boundary is the same (this API).
    const lambdaIntegration = (id: string, fn: IFunction) => new ApiWideLambdaIntegration(id, fn);
    const assetIntegration = lambdaIntegration('AssetInt', assetProxy);
    const serverIntegration = serverFn ? lambdaIntegration('SsrInt', serverFn) : undefined;
    const imageIntegration = imageFn ? lambdaIntegration('ImageInt', imageFn) : undefined;

    this.api = new HttpApi(this, 'HttpApi', {
      apiName: `blocks-${buildId}`.substring(0, 128),
      // Catch-all: SSR when present, else the asset proxy (SPA fallback on miss).
      defaultIntegration: serverIntegration ?? assetIntegration,
    });

    const integrationForKind = (kind: 'static' | 'server' | 'image') =>
      kind === 'server' ? (serverIntegration ?? assetIntegration)
      : kind === 'image' ? (imageIntegration ?? assetIntegration)
      : assetIntegration;

    // Same-origin backend routing (native HTTP proxy — HTTP API can proxy an
    // external HTTPS URL directly, no forwarder Lambda). Each backend origin
    // path-routes its namespace to that compute's ingress. A lone `'*'` origin
    // is the single-compute case: every API path (`/aws-blocks/*`, which covers
    // sign-in at `/aws-blocks/auth/*`, plus the backend's raw routes) → one
    // backend; a named namespace routes `/aws-blocks/api/{ns}/*`.
    const backendPaths = new Set<string>();
    for (const origin of plan.backend?.origins ?? []) {
      // Split the ingress URL on the `/aws-blocks/api` suffix (token-safe) to get
      // the backend base — the same URL shape whether it is a Lambda API Gateway,
      // a container ALB, or a BYOC endpoint.
      const base = backendBaseUrl(origin.ingress.url); // https://…/prod
      if (origin.namespace === '*') {
        let i = 0;
        for (const pattern of routableApiPaths(this, 'API Gateway', props.apiPaths ?? DEFAULT_API_PATHS)) {
          for (const route of apiPathToRoutes(pattern, 'API Gateway')) {
            if (backendPaths.has(route.path)) continue;
            backendPaths.add(route.path);
            // `BackendRpc` is the `/aws-blocks/{proxy+}` route's integration.
            const id = route.path === '/aws-blocks/{proxy+}' ? 'BackendRpc' : `BackendRoute${++i}`;
            this.api.addRoutes({
              path: route.path,
              methods: [HttpMethod.ANY],
              integration: new HttpUrlIntegration(id, `${base}${route.target}`),
            });
          }
        }
      } else {
        const ns = origin.namespace;
        this.api.addRoutes({
          path: `/aws-blocks/api/${ns}/{proxy+}`,
          methods: [HttpMethod.ANY],
          integration: new HttpUrlIntegration(`BackendNs-${ns}`, `${base}/aws-blocks/api/${ns}/{proxy}`),
        });
      }
    }

    // Route table → routes (deduped; catch-all handled by defaultIntegration).
    const seen = new Set<string>();
    // Routes served by a compute other than the server go straight to it; the
    // route table lists them as server routes, so they are claimed first.
    const computeIntegrations = new Map<string, HttpLambdaIntegration>();
    for (const r of props.computeRoutes ?? []) {
      const fn = compute.get(r.computeName);
      const path = globToProxyPath(r.pattern);
      if (!fn || path === null || seen.has(path) || backendPaths.has(path)) continue;
      let integration = computeIntegrations.get(r.computeName);
      if (!integration) {
        integration = new HttpLambdaIntegration(`ComputeInt-${r.computeName}`, fn);
        computeIntegrations.set(r.computeName, integration);
      }
      seen.add(path);
      this.api.addRoutes({ path, methods: [HttpMethod.ANY], integration });
    }
    // No image function: the framework image endpoints go to the asset proxy,
    // which answers them with the source image.
    if (props.imageFallback && !imageFn) {
      const base = (plan.policies.basePath ?? '').replace(/\/+$/, '');
      const pathForms = imagePathPrefixes(props.imageFallback.pathPrefixes).map((p) => `${base}${p}/{proxy+}`);
      for (const path of [`${base}/_next/image`, ...pathForms, `${base}/_image`]) {
        if (seen.has(path)) continue;
        seen.add(path);
        this.api.addRoutes({ path, methods: [HttpMethod.ANY], integration: assetIntegration });
      }
    }
    // Redirect sources first: each routes to the asset proxy, which answers the
    // redirect with the CloudFront door's semantics (first match, wildcard tail
    // spliced). A source with an inner wildcard has no route form.
    const unroutedRedirects: string[] = [];
    for (const r of plan.routes.redirects) {
      const path = globToProxyPath(r.source);
      if (path !== null && path.includes('*')) {
        unroutedRedirects.push(r.source);
        continue;
      }
      if (path === null || seen.has(path) || backendPaths.has(path)) continue;
      if (path.startsWith('/aws-blocks/')) continue; // backend owns these
      seen.add(path);
      this.api.addRoutes({ path, methods: [HttpMethod.ANY], integration: assetIntegration });
    }
    const inexpressible: string[] = [];
    for (const entry of plan.routes.entries) {
      // A wildcard inside a segment (`/*.js`) has no route form: the default serves it.
      if (hasInnerWildcard(entry.pattern)) {
        // `/_next/image*` with no image function: its endpoint is already
        // routed to the asset proxy above, so nothing is left unrouted.
        if (!seen.has(entry.pattern.replace(/\*$/, ''))) inexpressible.push(entry.pattern);
        continue;
      }
      const path = globToProxyPath(entry.pattern);
      if (path === null || seen.has(path) || backendPaths.has(path)) continue;
      if (path.startsWith('/aws-blocks/')) continue; // backend owns these
      seen.add(path);
      this.api.addRoutes({ path, methods: [HttpMethod.ANY], integration: integrationForKind(entry.kind) });
    }
    warnInexpressibleRoutes(this, 'API Gateway', inexpressible);
    // Behind a server default, a redirect with no route reaches the server, not the proxy.
    if (serverIntegration) warnUnroutedRedirects(this, 'API Gateway', unroutedRedirects);
    const routeCount = seen.size + backendPaths.size + 1; // + $default
    if (routeCount > APIGW_DEFAULT_ROUTE_QUOTA) {
      Annotations.of(this).addWarning(
        `The API Gateway front door defines ${routeCount} routes; an HTTP API allows ${APIGW_DEFAULT_ROUTE_QUOTA} by default. ` +
          'Request a quota increase, or group raw routes under fewer path prefixes.',
      );
    }

    // The rules the proxies can't apply: responses API Gateway sends straight
    // to a function or (natively) to the backend.
    warnRulesNotApplied(this, {
      door: 'API Gateway',
      headers: plan.routes.headers,
      errorPages: Boolean(props.errorPages?.notFound || props.errorPages?.serverError),
      server: Boolean(serverFn),
      image: Boolean(imageFn),
      nativeApi: backendPaths.size > 0,
      api: (plan.backend?.origins.length ?? 0) > 0,
    });

    this.url = this.api.apiEndpoint; // https://<id>.execute-api.<region>.amazonaws.com

    // Custom domain(s): a regional DomainName + API mapping per name, with a
    // Route 53 A/AAAA alias to the gateway's regional domain. The primary name
    // becomes the door's URL.
    if (props.domain) {
      const { certificate, hostedZone, names } = resolveApiGwDomain(this, 'Domain', props.domain);
      names.forEach((name, i) => {
        const dn = new DomainName(this, `Domain${i}`, { domainName: name, certificate });
        new ApiMapping(this, `DomainMap${i}`, { api: this.api, domainName: dn });
        if (hostedZone) {
          const target = RecordTarget.fromAlias(
            new ApiGatewayv2DomainProperties(dn.regionalDomainName, dn.regionalHostedZoneId),
          );
          new ARecord(this, `DomainA${i}`, { zone: hostedZone, recordName: name, target });
          new AaaaRecord(this, `DomainAAAA${i}`, { zone: hostedZone, recordName: name, target });
        }
      });
      this.url = `https://${names[0]}`;
    }

    new CfnOutput(this, 'ApiGatewayUrl', { value: this.url, description: 'API Gateway HTTP API front-door URL' });
  }
}

/**
 * Warn at synth (`@aws-blocks/hosting:RouteNotExpressible`) for route-table
 * patterns API Gateway has no path form for (a wildcard inside a segment):
 * the door's default integration serves them instead.
 *
 * @internal Framework-only.
 */
export const warnInexpressibleRoutes = (scope: Construct, door: string, patterns: readonly string[]): void => {
  if (patterns.length === 0) return;
  Annotations.of(scope).addWarningV2(
    '@aws-blocks/hosting:RouteNotExpressible',
    `The ${door} front door can't express these route patterns (a wildcard inside a path segment), so its default ` +
      `integration serves them: ${patterns.join(', ')}.`,
  );
};

/**
 * Warn at synth (`@aws-blocks/hosting:RedirectNotExpressible`) for redirect
 * sources API Gateway has no path form for (a wildcard inside a segment, e.g.
 * `/old/*.html`) on a door whose default integration is the server: no route
 * sends them to the asset proxy, which applies redirects, so the server
 * answers those requests instead (typically a 404).
 *
 * @internal Framework-only.
 */
export const warnUnroutedRedirects = (scope: Construct, door: string, sources: readonly string[]): void => {
  if (sources.length === 0) return;
  Annotations.of(scope).addWarningV2(
    '@aws-blocks/hosting:RedirectNotExpressible',
    `The ${door} front door can't route these redirect sources (a wildcard inside a path segment), so the redirects ` +
      `never apply and the server answers those requests: ${sources.join(', ')}. Use a whole trailing segment ` +
      "(`/path/*`), or the CloudFront or ALB door.",
  );
};
