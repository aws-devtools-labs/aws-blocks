/**
 * API Gateway front-door adapter — a cheap, regional, HTTPS-by-default,
 * no-CloudFront door. Renders the same {@link CapabilityPlan} as CloudFront/ALB
 * onto either a REST API ({@link ApiGatewayRestConstruct}, the default — no
 * Function-URL body-hash issue) or an HTTP API v2 ({@link ApiGatewayConstruct},
 * cheaper), selected by `ctx.apiType`.
 *
 * Best fit: a SPA/SSR app that doesn't want a CDN — pay-per-request,
 * scale-to-zero, no ALB/NAT idle cost, same-origin `/aws-blocks/*` (so cookie
 * auth works with no CORS). It generalizes the preview `bypass_origin` shape
 * into a first-class adapter.
 */
import { Fn } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { HostingError } from '../hosting_error.js';
import type { FrontDoorLayerAdapter, LayerHandle } from './layer.js';
import { formatNegotiationErrors, negotiate } from '../plan/negotiate.js';
import type {
  AdapterContext,
  CapabilityId,
  CapabilityPlan,
  FrontDoorAdapter,
  FrontDoorResult,
  SupportTier,
} from '../plan/types.js';
import { ApiGatewayConstruct } from './apigw_construct.js';
import type { ApiGwCustomDomain } from './apigw_domain.js';
import { ApiGatewayRestConstruct } from './apigw_rest_construct.js';

/** API Gateway HTTP API's per-capability support. */
const APIGW_SUPPORT: Record<CapabilityId, SupportTier> = {
  RouteRequest: 'extended', // API routes instead of KVS + CF Function
  ServeStaticAsset: 'extended', // asset-proxy Lambda instead of S3+OAC
  RunServerRender: 'core',
  StreamServerRender: 'unsupported', // HTTP API cannot stream responses (buffered only)
  ProxySameOriginApi: 'core', // native HTTP proxy to the backend API Gateway
  RouteApiNamespace: 'core', // a route per namespace → each compute's ingress (HttpUrlIntegration)
  LongRequest: 'unsupported', // HTTP API hard ~29 s integration timeout — caps long backend work
  LargePayload: 'degraded', // ~10 MB payload cap on the router path
  CustomDomainTls: 'core', // HTTPS by default; custom domain via API GW domain names
  InjectResponseHeaders: 'degraded', // no per-route response-header injection
  FilterRequests: 'degraded', // no native WAF on HTTP API (REST API only) → WAF elsewhere
  CacheResponses: 'degraded', // no global edge cache
  AtomicRelease: 'extended', // build-id prefixed S3 keys; no KVS cutover
  PinSession: 'degraded', // no edge function for the skew cookie
  OptimizeImage: 'core', // the image-opt Lambda as an integration
  RestrictGeo: 'unsupported', // no geo control on HTTP API
  AccessLogging: 'unsupported', // access logging not wired in ApiGatewayConstruct yet (follow-on)
  ServeErrorPage: 'unsupported', // no gateway-response error pages wired
  Redirect: 'unsupported', // HTTP API has no redirect primitive
  Alarms: 'unsupported', // MonitoringConstruct is CloudFront-only today
};

export type ApiGatewayRenderContext = AdapterContext & {
  bucket: IBucket;
  computeFunctions?: Map<string, IFunction>;
  serverComputeName?: string;
  imageComputeName?: string;
  /**
   * Which API Gateway flavor to render. `'http'` (default) uses HTTP API v2 — its
   * `$default` stage is rootless, so a SPA's root-absolute assets resolve. `'rest'`
   * uses a REST API (`lambda:InvokeFunction`, native `HTTP_PROXY` backend) but its
   * URL carries a `/prod` stage path, so it needs a custom domain / CloudFront.
   */
  apiType?: 'rest' | 'http';
  /** Custom domain(s) for the door — a regional cert + DomainName + mapping + Route 53 alias. */
  domain?: ApiGwCustomDomain;
  degrade?: CapabilityId[];
};

export class ApiGatewayAdapter implements FrontDoorAdapter, FrontDoorLayerAdapter {
  readonly service = 'api-gateway';

  supports(capability: CapabilityId): SupportTier {
    return APIGW_SUPPORT[capability];
  }

  render(scope: Construct, plan: CapabilityPlan, ctx: ApiGatewayRenderContext): FrontDoorResult {
    return { url: this.renderLayer(scope, plan, ctx).url ?? '' };
  }

  /**
   * Render the HTTP API as a layer. The {@link OriginHandle} is the API endpoint
   * host (scheme stripped, token-safe) — HTTPS by default.
   */
  renderLayer(scope: Construct, plan: CapabilityPlan, ctx: ApiGatewayRenderContext): LayerHandle {
    const result = negotiate(plan, this, { degrade: ctx.degrade });
    if (result.errors.length > 0) {
      throw new HostingError('CapabilityNotSupportedError', {
        message: formatNegotiationErrors(this.service, result),
        resolution:
          'Choose a front door that supports these capabilities (e.g. cloudfront/alb), or accept the ' +
          'degraded behavior explicitly by listing the capability in `degrade`.',
      });
    }
    for (const w of result.warnings) {
      process.stderr.write(
        `⚠️  Hosting(api-gateway): capability '${w.capability}' runs in a degraded form (accepted via \`degrade\`).\n`,
      );
    }

    const constructProps = {
      plan,
      bucket: ctx.bucket,
      computeFunctions: ctx.computeFunctions,
      serverComputeName: ctx.serverComputeName,
      imageComputeName: ctx.imageComputeName,
      domain: ctx.domain,
    };
    // REST (default) or HTTP API v2. Both expose `.url`; the REST URL carries a
    // `/prod` stage, so derive the origin host from the URL's host segment
    // (index 2 of `https://host/…`), not the scheme split used for HTTP API.
    const isRest = (ctx.apiType ?? 'http') === 'rest';
    if (isRest) {
      const apigw = new ApiGatewayRestConstruct(scope, 'ApiGateway', constructProps);
      return {
        url: apigw.url,
        originHandle: { domainName: Fn.select(2, Fn.split('/', apigw.url)), protocol: 'https' },
      };
    }
    const apigw = new ApiGatewayConstruct(scope, 'ApiGateway', constructProps);
    return {
      url: apigw.url,
      originHandle: { domainName: Fn.select(1, Fn.split('://', apigw.url)), protocol: 'https' },
    };
  }
}
