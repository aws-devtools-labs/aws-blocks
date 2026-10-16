/**
 * API Gateway front door, defined with hooks — a regional, HTTPS-by-default,
 * no-CloudFront door. Renders the same {@link CapabilityPlan} as CloudFront/ALB
 * onto either an HTTP API v2 ({@link ApiGatewayConstruct}, the **default** — its
 * auto `$default` stage is rootless, so a SPA's root-absolute assets resolve) or
 * a REST API ({@link ApiGatewayRestConstruct}, for use behind a custom domain /
 * CloudFront — a bare REST URL's `/prod` stage path breaks root-absolute assets),
 * selected by `ctx.apiType`.
 *
 * Serverless — pay-per-request, scale-to-zero, no VPC/NAT. Serves
 * `/aws-blocks/*` same-origin (so cookie auth works with no CORS).
 *
 * What it delivers, read off its hooks:
 *   - `route` — a route per origin (asset-proxy → private S3, SSR/image
 *     Lambdas). Reports BUFFERED SSR (no response streaming), image
 *     optimization, and atomic release (build-id-prefixed keys). No redirects,
 *     error pages, edge cache, response headers, or session pinning.
 *   - feature hooks — same-origin API (native HTTP proxy, per namespace) and a
 *     custom domain. No `waf` / `restrictGeo` / `accessLogs` / `alarms` hooks →
 *     those are unsupported.
 */
import { Fn } from 'aws-cdk-lib';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { AdapterContext, CapabilityId, CapabilityPlan } from '../plan/types.js';
import { ApiGatewayConstruct, type ApiGatewayConstructProps } from './apigw_construct.js';
import type { ApiGwCustomDomain } from './apigw_domain.js';
import { ApiGatewayRestConstruct } from './apigw_rest_construct.js';
import { defineFrontDoor } from './door_hooks.js';
import type { NegotiationMode } from './negotiation_policy.js';

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
  /** How strictly the capability check is enforced (`'strict'` default · `'warn'` · `'off'`). */
  negotiation?: NegotiationMode;
};

/** The door's state: construct props the hooks fill in, built by `handle`. */
type ApiGwDoorState = { scope: Construct; props: Omit<ApiGatewayConstructProps, 'plan'>; plan?: CapabilityPlan };

export const apiGatewayDoor = defineFrontDoor<ApiGwDoorState, ApiGatewayRenderContext>({
  service: 'api-gateway',

  create(scope, ctx) {
    return {
      scope,
      props: {
        bucket: ctx.bucket,
        computeFunctions: ctx.computeFunctions,
        serverComputeName: ctx.serverComputeName,
        imageComputeName: ctx.imageComputeName,
      },
    };
  },

  route(door, plan) {
    door.plan = plan;
    return {
      ssr: plan.policies.hasServer ? 'buffered' : false,
      images: true,
      atomicRelease: true,
    };
  },

  /**
   * The {@link OriginHandle} is the API endpoint host (scheme stripped,
   * token-safe) — HTTPS by default. The REST URL carries a `/prod` stage, so its
   * host is the URL's host segment (index 2 of `https://host/…`).
   */
  handle(door, ctx) {
    if (!door.plan) throw new Error("api-gateway door: 'route' must run before 'handle'.");
    const props = { ...door.props, plan: door.plan };
    if ((ctx.apiType ?? 'http') === 'rest') {
      const apigw = new ApiGatewayRestConstruct(door.scope, 'ApiGateway', props);
      return {
        url: apigw.url,
        originHandle: { domainName: Fn.select(2, Fn.split('/', apigw.url)), protocol: 'https' },
      };
    }
    const apigw = new ApiGatewayConstruct(door.scope, 'ApiGateway', props);
    return {
      url: apigw.url,
      originHandle: { domainName: Fn.select(1, Fn.split('://', apigw.url)), protocol: 'https' },
    };
  },

  // A route per `plan.backend` namespace → each compute's ingress.
  sameOriginApi: () => 'namespaced',
  customDomain(door, ctx) {
    door.props.domain = ctx.domain;
  },
});
