/**
 * API Gateway (HTTP API v2) front-door construct — a cheap, regional,
 * HTTPS-by-default, no-CloudFront door.
 *
 * Serves the whole deploy from ONE HTTP API at the domain root (the auto
 * `$default` stage is rootless, so framework root-absolute URLs resolve):
 *   - static routes  → an asset-proxy Lambda integration (streams from the
 *     PRIVATE S3 bucket) — the API-Gateway analogue of CloudFront's S3+OAC.
 *   - `$default`      → the SSR server Lambda (or the asset proxy for a static
 *     site, which serves index.html on a miss for SPA fallback).
 *   - image routes    → the image-opt Lambda.
 *   - `/aws-blocks/*` + `/aws-blocks-auth/*` → an HTTP proxy integration
 *     straight to the backend API Gateway (same-origin; no forwarder Lambda
 *     needed, unlike ALB — HTTP API can proxy an external HTTPS URL natively).
 *
 * Trade-offs (declared `degraded`/`unsupported` on {@link ApiGatewayAdapter},
 * enforced by the negotiator): no global edge cache, no per-route response
 * headers, no skew-pin, buffered SSR only (HTTP API can't stream), ~6 MB
 * response cap.
 */
import { CfnOutput, Duration, Fn } from 'aws-cdk-lib';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration, HttpUrlIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Code, Function as LambdaFunction, type IFunction } from 'aws-cdk-lib/aws-lambda';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { CapabilityPlan } from '../plan/types.js';
import { generateApiGwAssetProxyCode } from './apigw_asset_proxy.js';
import { DEFAULT_NODE_RUNTIME } from './node_runtime.js';

export type ApiGatewayConstructProps = {
  plan: CapabilityPlan;
  bucket: IBucket;
  computeFunctions?: Map<string, IFunction>;
  serverComputeName?: string;
  imageComputeName?: string;
};

/** Convert a route-table glob pattern to an API Gateway HTTP API route path (or null for the catch-all). */
const toApiGwPath = (pattern: string): string | null => {
  if (pattern === '/*' || pattern === '*') return null; // → $default
  if (pattern.endsWith('/*')) return `${pattern.slice(0, -2)}/{proxy+}`;
  return pattern; // exact
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
    // is the single-compute case (the whole `/aws-blocks/*` + `/aws-blocks-auth/*`
    // subtree → one backend); a named namespace routes `/aws-blocks/api/{ns}/*`.
    for (const origin of plan.backend?.origins ?? []) {
      // Split the ingress URL on the `/aws-blocks/api` suffix (token-safe) to get
      // the backend base — the same URL shape whether it is a Lambda API Gateway,
      // a container ALB, or a BYOC endpoint.
      const base = Fn.select(0, Fn.split('/aws-blocks/api', origin.ingress.url)); // https://…/prod
      if (origin.namespace === '*') {
        this.api.addRoutes({
          path: '/aws-blocks/{proxy+}',
          methods: [HttpMethod.ANY],
          integration: new HttpUrlIntegration('BackendRpc', `${base}/aws-blocks/{proxy}`),
        });
        this.api.addRoutes({
          path: '/aws-blocks-auth/{proxy+}',
          methods: [HttpMethod.ANY],
          integration: new HttpUrlIntegration('BackendAuth', `${base}/aws-blocks-auth/{proxy}`),
        });
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
      const path = toApiGwPath(entry.pattern);
      if (path === null || seen.has(path)) continue;
      if (path.startsWith('/aws-blocks/') || path.startsWith('/aws-blocks-auth/')) continue; // backend owns these
      seen.add(path);
      this.api.addRoutes({ path, methods: [HttpMethod.ANY], integration: integrationForKind(entry.kind) });
    }

    this.url = this.api.apiEndpoint; // https://<id>.execute-api.<region>.amazonaws.com
    new CfnOutput(this, 'ApiGatewayUrl', { value: this.url, description: 'API Gateway HTTP API front-door URL' });
  }
}
