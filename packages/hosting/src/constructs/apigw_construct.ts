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
 * Not provided (an app that asks for these deploys without them — there is no
 * feature check): no global edge cache, no per-route response-header
 * injection, no skew-pin, buffered SSR only (HTTP API can't stream). API Gateway also imposes a ~29 s request timeout and a
 * ~10 MB payload / ~6 MB response cap. Stage-level config (WAF, TLS/domain,
 * access logs, throttle) applies to the whole API, not per route.
 */
import { Annotations, CfnOutput, Duration } from 'aws-cdk-lib';
import { ApiMapping, DomainName, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration, HttpUrlIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Code, Function as LambdaFunction, type IFunction } from 'aws-cdk-lib/aws-lambda';
import { AaaaRecord, ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { ApiGatewayv2DomainProperties } from 'aws-cdk-lib/aws-route53-targets';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { CapabilityPlan } from '../plan/types.js';
import { generateApiGwAssetProxyCode } from './apigw_asset_proxy.js';
import { type ApiGwCustomDomain, resolveApiGwDomain } from './apigw_domain.js';
import {
  APIGW_DEFAULT_ROUTE_QUOTA,
  apiPathToRoute,
  backendBaseUrl,
  DEFAULT_API_PATHS,
  globToProxyPath,
} from './apigw_routes.js';
import { DEFAULT_NODE_RUNTIME } from './node_runtime.js';

export type ApiGatewayConstructProps = {
  plan: CapabilityPlan;
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
};

export class ApiGatewayConstruct extends Construct {
  readonly api: HttpApi;
  readonly url: string;

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
      code: Code.fromInline(generateApiGwAssetProxyCode({ stripPrefix, spaFallback })),
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: { ASSET_BUCKET: bucket.bucketName, ASSET_KEY_PREFIX: `builds/${buildId}` },
    });
    bucket.grantRead(assetProxy);

    const assetIntegration = new HttpLambdaIntegration('AssetInt', assetProxy);
    const serverIntegration = serverFn ? new HttpLambdaIntegration('SsrInt', serverFn) : undefined;
    const imageIntegration = imageFn ? new HttpLambdaIntegration('ImageInt', imageFn) : undefined;

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
        for (const pattern of new Set(props.apiPaths ?? DEFAULT_API_PATHS)) {
          const route = apiPathToRoute(pattern);
          if (!route || backendPaths.has(route.path)) continue;
          backendPaths.add(route.path);
          // The first id stays `BackendRpc` (the `/aws-blocks/*` route), so an
          // existing deploy's integration keeps its logical id.
          const id = i++ === 0 ? 'BackendRpc' : `BackendRoute${i - 1}`;
          this.api.addRoutes({
            path: route.path,
            methods: [HttpMethod.ANY],
            integration: new HttpUrlIntegration(id, `${base}${route.target}`),
          });
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
    for (const entry of plan.routes.entries) {
      const path = globToProxyPath(entry.pattern);
      if (path === null || seen.has(path) || backendPaths.has(path)) continue;
      if (path.startsWith('/aws-blocks/')) continue; // backend owns these
      seen.add(path);
      this.api.addRoutes({ path, methods: [HttpMethod.ANY], integration: integrationForKind(entry.kind) });
    }
    const routeCount = seen.size + backendPaths.size + 1; // + $default
    if (routeCount > APIGW_DEFAULT_ROUTE_QUOTA) {
      Annotations.of(this).addWarning(
        `The API Gateway front door defines ${routeCount} routes; an HTTP API allows ${APIGW_DEFAULT_ROUTE_QUOTA} by default. ` +
          'Request a quota increase, or group raw routes under fewer path prefixes.',
      );
    }

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
