/**
 * CloudFront front-door adapter — the first concrete {@link FrontDoorAdapter}.
 *
 * This is the typed seam that makes CloudFront ONE renderer of a
 * {@link CapabilityPlan} rather than an ambient assumption. It declares, per
 * {@link CapabilityId}, how well CloudFront supports it (its {@link SupportTier})
 * so the future capability negotiator can enforce conscious degradation, and it
 * renders a plan by materializing the existing {@link HostingConstruct}-owned
 * {@link CdnConstruct}.
 *
 * NOTE (Phase 1): `HostingConstruct` still constructs `CdnConstruct` directly;
 * this adapter is the declared, tested implementor of the seam. Routing all
 * front-door construction through `render()` is deferred until a SECOND adapter
 * (ALB) exists to justify the abstraction — an interface with a single caller is
 * a guess, so we prove the seam with a second implementation first (see the
 * revamp plan). CloudFront's capability matrix, however, is real and consumed by
 * tests now.
 */
import type { Construct } from 'constructs';
import type {
  AdapterContext,
  CapabilityId,
  CapabilityPlan,
  FrontDoorAdapter,
  FrontDoorResult,
  SupportTier,
} from '../plan/types.js';
import { CdnConstruct, type CdnConstructProps } from './cdn_construct.js';
import type { ChildHandles, FrontDoorLayerAdapter, LayerHandle } from './layer.js';

/**
 * CloudFront's per-capability support. CloudFront is the full-feature default:
 * it supports every hosting capability the standard (`core`) way — global edge
 * caching, streaming SSR, Lambda@Edge / CloudFront Functions, OAC private
 * origins, a ResponseHeadersPolicy, a CLOUDFRONT-scoped WAF, and geo
 * restriction. This table is the CloudFront column of the capability × service
 * matrix; other adapters (ALB, API Gateway) will declare their own, where some
 * cells are `extended`, `degraded`, or `unsupported`.
 */
const CLOUDFRONT_SUPPORT: Record<CapabilityId, SupportTier> = {
  RouteRequest: 'core',
  ServeStaticAsset: 'core',
  RunServerRender: 'core',
  StreamServerRender: 'core',
  ProxySameOriginApi: 'core',
  RouteApiNamespace: 'core', // a behavior per namespace → each compute's ingress
  LongRequest: 'core', // routes to the origin; the origin's own timeout applies
  LargePayload: 'core', // proxied to the origin without a router-imposed size cap
  CustomDomainTls: 'core',
  InjectResponseHeaders: 'core',
  FilterRequests: 'core',
  CacheResponses: 'core',
  AtomicRelease: 'core',
  PinSession: 'core',
  OptimizeImage: 'core',
  RestrictGeo: 'core',
  AccessLogging: 'core', // enableLogging + logBucket
  ServeErrorPage: 'core', // custom error responses / error-page HTML
  Redirect: 'core', // CloudFront Function (www↔apex) + KVS redirects
  Alarms: 'core', // MonitoringConstruct (CF 5xx, Lambda errors/throttles, DLQ)
};

/**
 * Context the CloudFront adapter needs beyond the neutral plan: the CDK handles
 * the plan cannot carry (the assets bucket, compute functions, certificate, WAF,
 * …). These are exactly the {@link CdnConstruct} props that are not derivable
 * from the plan; the adapter threads the plan-derived bits (routing, origins,
 * policies) through separately.
 */
export type CloudFrontRenderContext = AdapterContext & {
  /** The underlying CloudFront construct props (CDK handles + the manifest). */
  cdnProps: CdnConstructProps;
};

/**
 * CloudFront implementation of the {@link FrontDoorAdapter} seam.
 */
export class CloudFrontAdapter implements FrontDoorAdapter, FrontDoorLayerAdapter {
  readonly service = 'cloudfront';

  /** How well CloudFront supports a given capability (always the standard way). */
  supports(capability: CapabilityId): SupportTier {
    return CLOUDFRONT_SUPPORT[capability];
  }

  /**
   * Render the plan onto CloudFront by materializing a {@link CdnConstruct}.
   * The CloudFront renderer already consumes the plan internally (it builds the
   * same `CapabilityPlan` and calls `renderKvsEntries`); this method is the
   * adapter-level entry point that a plan-driven `HostingConstruct` will call
   * once multiple adapters exist.
   */
  render(scope: Construct, plan: CapabilityPlan, ctx: CloudFrontRenderContext): FrontDoorResult {
    return { url: this.renderLayer(scope, plan, ctx).url ?? '' };
  }

  /**
   * Render CloudFront as a layer, returning a {@link LayerHandle}: the public URL
   * plus the distribution domain a parent could attach to (CloudFront is normally
   * the root edge, so it rarely has a parent — the handle is provided for
   * uniformity).
   */
  renderLayer(
    scope: Construct,
    _plan: CapabilityPlan,
    ctx: CloudFrontRenderContext,
    children?: ChildHandles,
  ): LayerHandle {
    // Composition: front each nested child layer (e.g. an ALB router) as a public
    // HTTP origin at its path. The child's `match` selector is the behavior
    // pattern; its `originHandle` gives the host + protocol.
    const childOrigins = [...(children ?? new Map()).entries()].map(([match, handle]) => ({
      pattern: match,
      domainName: handle.originHandle.domainName,
      protocol: handle.originHandle.protocol,
    }));
    const cdnProps =
      childOrigins.length > 0
        ? { ...ctx.cdnProps, extraHttpOrigins: [...(ctx.cdnProps.extraHttpOrigins ?? []), ...childOrigins] }
        : ctx.cdnProps;
    const cdn = new CdnConstruct(scope, 'Cdn', cdnProps);
    return {
      url: cdn.distributionUrl,
      originHandle: { domainName: cdn.distribution.distributionDomainName, protocol: 'https' },
    };
  }
}
