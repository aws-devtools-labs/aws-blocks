/**
 * ALB front-door adapter — renders the same {@link CapabilityPlan} as the
 * CloudFront adapter onto an Application Load Balancer (see {@link AlbConstruct}).
 *
 * Its {@link supports} matrix is the ALB column of the capability × service
 * table: routing/static/atomic and SSR/streaming/image/TLS/WAF are `supported`
 * (routing/static/atomic via a different mechanism — listener rules, an
 * asset-proxy Lambda, target-group swap), and the CloudFront-edge-only
 * capabilities (edge caching, per-route response headers, skew-pin, geo) are
 * `unsupported` — so the negotiator makes any
 * loss EXPLICIT (fail unless the app opts into `degrade`) rather than silent.
 */
import type { Construct } from 'constructs';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import type { IVpc } from 'aws-cdk-lib/aws-ec2';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { enforceNegotiation, type NegotiationMode } from './negotiation_policy.js';
import type {
  AdapterContext,
  CapabilityId,
  CapabilityPlan,
  FrontDoorAdapter,
  FrontDoorResult,
  SupportTier,
} from '../plan/types.js';
import { AlbConstruct } from './alb_construct.js';
import type { FrontDoorLayerAdapter, LayerHandle } from './layer.js';

/** ALB's per-capability support — the ALB column of the capability × service matrix. */
const ALB_SUPPORT: Record<CapabilityId, SupportTier> = {
  RouteRequest: 'supported', // listener rules instead of a KVS + CF Function
  ServeStaticAsset: 'supported', // an asset-proxy Lambda target instead of S3+OAC
  RunServerRender: 'supported',
  StreamServerRender: 'supported', // ALB holds a long streaming connection to its target
  ProxySameOriginApi: 'supported', // same ALB routes the API subtree to the server target
  RouteApiNamespace: 'supported', // per-namespace listener rules → a forwarder Lambda per ingress
  CustomDomainTls: 'supported', // HTTPS listener + a regional ACM cert
  InjectResponseHeaders: 'unsupported', // ALB can't inject per-route response headers → move into SSR/origin
  FilterRequests: 'supported', // native WAFv2 REGIONAL WebACL associated with the ALB
  CacheResponses: 'unsupported', // no global edge cache; a regional cache is the caller's own concern
  AtomicRelease: 'supported', // build-id prefixed keys + target-group swap instead of a KVS cutover
  PinSession: 'unsupported', // no edge function to stamp the skew cookie → move into SSR or drop
  OptimizeImage: 'supported', // the image-opt Lambda as a target
  RestrictGeo: 'unsupported', // needs WAF geo rules; no WAF wired on the ALB today
  AccessLogging: 'supported', // native ALB access logs → S3
  ServeErrorPage: 'unsupported', // on ALB the ORIGIN serves app 404/500s; fixed-response is a maintenance page, not an origin-error interceptor — not forced
  Redirect: 'supported', // listener redirect rules from the plan's redirects
  Alarms: 'supported', // CloudWatch alarms on the ALB's own metrics (5xx, latency)
};

/** Context the ALB adapter needs beyond the plan: CDK handles + network/TLS options. */
export type AlbRenderContext = AdapterContext & {
  bucket: IBucket;
  computeFunctions?: Map<string, IFunction>;
  serverComputeName?: string;
  imageComputeName?: string;
  vpc?: IVpc;
  internal?: boolean;
  certificate?: ICertificate;
  /** Enable native ALB access logging → S3 (`AccessLogging`). */
  accessLogging?: boolean;
  /** Native WAFv2 REGIONAL WebACL for the ALB (`FilterRequests`). */
  waf?: { enabled?: boolean; rateLimit?: number; webAclArn?: string };
  /** Emit CloudWatch alarms on the ALB's own metrics (`Alarms`). */
  monitoring?: boolean;
  /** Capabilities the app explicitly waives — deploy without them (else the negotiator fails). */
  degrade?: CapabilityId[];
  /** How strictly the capability check is enforced (`'strict'` default · `'warn'` · `'off'`). */
  negotiation?: NegotiationMode;
};

export class AlbAdapter implements FrontDoorAdapter, FrontDoorLayerAdapter {
  readonly service = 'alb';

  supports(capability: CapabilityId): SupportTier {
    return ALB_SUPPORT[capability];
  }

  render(scope: Construct, plan: CapabilityPlan, ctx: AlbRenderContext): FrontDoorResult {
    return { url: this.renderLayer(scope, plan, ctx).url ?? '' };
  }

  /**
   * Render the ALB as a layer. The {@link OriginHandle} is the load balancer's
   * DNS name — what a parent edge (e.g. CloudFront) would front — with the
   * protocol reflecting whether an HTTPS listener (a certificate) is configured.
   */
  renderLayer(scope: Construct, plan: CapabilityPlan, ctx: AlbRenderContext): LayerHandle {
    // Conscious degradation: fail synth if the plan requires a capability ALB
    // can't do (or degrades without opt-in). Never a silent drop.
    enforceNegotiation(plan, this, {
      degrade: ctx.degrade,
      negotiation: ctx.negotiation,
      errorCode: 'CapabilityNotSupportedError',
      resolution:
        'Choose a front door that supports these capabilities (e.g. CloudFront), or accept the ' +
          'missing capability explicitly by listing it in `degrade`.',
    });

    const alb = new AlbConstruct(scope, 'Alb', {
      plan,
      bucket: ctx.bucket,
      computeFunctions: ctx.computeFunctions,
      serverComputeName: ctx.serverComputeName,
      imageComputeName: ctx.imageComputeName,
      vpc: ctx.vpc,
      internal: ctx.internal,
      certificate: ctx.certificate,
      accessLogging: ctx.accessLogging,
      waf: ctx.waf,
      monitoring: ctx.monitoring,
    });
    return {
      url: alb.url,
      originHandle: {
        domainName: alb.loadBalancer.loadBalancerDnsName,
        protocol: ctx.certificate ? 'https' : 'http',
      },
    };
  }
}
