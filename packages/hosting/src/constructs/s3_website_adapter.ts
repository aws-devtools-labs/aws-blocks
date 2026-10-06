/**
 * S3 static-website front-door adapter — the simplest/cheapest door for a pure
 * static site / SPA (public website bucket, no CloudFront, no Lambda, no TLS).
 * Renders the {@link CapabilityPlan} onto an {@link S3WebsiteConstruct}.
 *
 * Everything dynamic is `unsupported` (no SSR/API/image/edge) and HTTPS is
 * unsupported (S3 website endpoints are HTTP-only) — the negotiator fails synth
 * for anything beyond static/SPA, steering those apps to a CDN/ALB/API-GW door.
 */
import { Fn } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { FrontDoorLayerAdapter, LayerHandle } from './layer.js';
import { enforceNegotiation, type NegotiationMode } from './negotiation_policy.js';
import type {
  AdapterContext,
  CapabilityId,
  CapabilityPlan,
  FrontDoorAdapter,
  FrontDoorResult,
  SupportTier,
} from '../plan/types.js';
import { S3WebsiteConstruct } from './s3_website_construct.js';

/** S3 website's per-capability support (static/SPA only, HTTP-only). */
const S3_WEBSITE_SUPPORT: Record<CapabilityId, SupportTier> = {
  RouteRequest: 'extended', // website index/error-document routing
  ServeStaticAsset: 'extended', // public website bucket
  RunServerRender: 'unsupported',
  StreamServerRender: 'unsupported',
  ProxySameOriginApi: 'unsupported',
  RouteApiNamespace: 'unsupported', // static bucket cannot route to a backend
  LongRequest: 'unsupported', // no compute
  LargePayload: 'unsupported', // no compute
  CustomDomainTls: 'unsupported', // S3 website endpoints are HTTP only
  InjectResponseHeaders: 'unsupported',
  FilterRequests: 'unsupported',
  CacheResponses: 'unsupported',
  AtomicRelease: 'degraded', // deploy overwrites the root; no build-id cutover
  PinSession: 'unsupported',
  OptimizeImage: 'unsupported',
  RestrictGeo: 'unsupported',
  AccessLogging: 'unsupported', // S3 server access logging not wired in the website construct yet
  ServeErrorPage: 'degraded', // has an S3 error-document slot (used for SPA fallback), not branded multi-status pages
  Redirect: 'unsupported', // S3 routing rules not wired for the plan's redirects
  Alarms: 'unsupported',
};

export type S3WebsiteRenderContext = AdapterContext & {
  /** The built static assets directory to publish. */
  staticDir: string;
  degrade?: CapabilityId[];
  /** How strictly the capability check is enforced (`'strict'` default · `'warn'` · `'off'`). */
  negotiation?: NegotiationMode;
};

export class S3WebsiteAdapter implements FrontDoorAdapter, FrontDoorLayerAdapter {
  readonly service = 's3-website';

  supports(capability: CapabilityId): SupportTier {
    return S3_WEBSITE_SUPPORT[capability];
  }

  render(scope: Construct, plan: CapabilityPlan, ctx: S3WebsiteRenderContext): FrontDoorResult {
    return { url: this.renderLayer(scope, plan, ctx).url ?? '' };
  }

  /**
   * Render the S3 website bucket as a layer. The {@link OriginHandle} is the
   * website endpoint host (HTTP-only — S3 website endpoints don't support TLS).
   */
  renderLayer(scope: Construct, plan: CapabilityPlan, ctx: S3WebsiteRenderContext): LayerHandle {
    enforceNegotiation(plan, this, {
      degrade: ctx.degrade,
      negotiation: ctx.negotiation,
      errorCode: 'CapabilityNotSupportedError',
      resolution:
        "`frontDoor: 'none'` serves a pure static site / SPA directly from S3 (HTTP only, no " +
        'front door). For SSR, a same-origin API, image optimization, HTTPS, or atomic deploys, ' +
        "use the CloudFront default (omit `frontDoor`) or `{ kind: 'alb' }`.",
    });
    const site = new S3WebsiteConstruct(scope, 'S3Website', { plan, staticDir: ctx.staticDir });
    return {
      url: site.url,
      originHandle: { domainName: Fn.select(1, Fn.split('://', site.url)), protocol: 'http' },
      // The public website bucket the SPA is served from — the wrapper publishes
      // config.json here (root `.blocks-sandbox/`) so the cross-origin client can
      // read the absolute API URL from the SAME origin it loads from.
      publicBucket: site.bucket,
    };
  }
}
