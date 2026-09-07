/**
 * ALB front-door adapter — the SECOND {@link FrontDoorAdapter}, and the first
 * that is NOT CloudFront. Its existence is what proves the Phase-1 seam is a
 * real abstraction and not a CloudFront-shaped guess: the same
 * {@link CapabilityPlan} the CloudFront adapter renders, this one renders onto
 * an Application Load Balancer (see {@link AlbConstruct}).
 *
 * Its {@link supports} matrix is the ALB column of the capability × service
 * table: routing/static/atomic are `extended` (a different mechanism — listener
 * rules, an asset-proxy Lambda, target-group swap), SSR/streaming/image/TLS/WAF
 * are `core`, and the CloudFront-edge-only capabilities (edge caching, per-route
 * response headers, skew-pin, geo) are `degraded` — so the negotiator makes any
 * loss EXPLICIT (fail unless the app opts into `degrade`) rather than silent.
 */
import type { Construct } from 'constructs';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import type { IVpc } from 'aws-cdk-lib/aws-ec2';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { HostingError } from '../hosting_error.js';
import { formatNegotiationErrors, negotiate } from '../plan/negotiate.js';
import type {
  AdapterContext,
  CapabilityId,
  CapabilityPlan,
  FrontDoorAdapter,
  FrontDoorResult,
  SupportTier,
} from '../plan/types.js';
import { AlbConstruct } from './alb_construct.js';

/** ALB's per-capability support — the ALB column of the capability × service matrix. */
const ALB_SUPPORT: Record<CapabilityId, SupportTier> = {
  RouteRequest: 'extended', // listener rules instead of a KVS + CF Function
  ServeStaticAsset: 'extended', // an asset-proxy Lambda target instead of S3+OAC
  RunServerRender: 'core',
  StreamServerRender: 'core', // ALB holds a long streaming connection to its target
  ProxySameOriginApi: 'core', // same ALB routes the API subtree to the server target
  CustomDomainTls: 'core', // HTTPS listener + a regional ACM cert
  InjectResponseHeaders: 'degraded', // ALB can't inject per-route response headers → move into SSR/origin
  FilterRequests: 'core', // a REGIONAL WAFv2 WebACL associates with the ALB
  CacheResponses: 'degraded', // no global edge cache; a regional cache is the caller's own concern
  AtomicRelease: 'extended', // build-id prefixed keys + target-group swap instead of a KVS cutover
  PinSession: 'degraded', // no edge function to stamp the skew cookie → move into SSR or drop
  OptimizeImage: 'core', // the image-opt Lambda as a target
  RestrictGeo: 'degraded', // via WAF geo rules, not a native CDN control
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
  /** Backend API Gateway URL to proxy same-origin (`/aws-blocks/*`) via a Lambda target. */
  backendApiUrl?: string;
  /** Capabilities the app explicitly accepts in degraded form (else the negotiator fails). */
  degrade?: CapabilityId[];
};

export class AlbAdapter implements FrontDoorAdapter {
  readonly service = 'alb';

  supports(capability: CapabilityId): SupportTier {
    return ALB_SUPPORT[capability];
  }

  render(scope: Construct, plan: CapabilityPlan, ctx: AlbRenderContext): FrontDoorResult {
    // Conscious degradation: fail synth if the plan requires a capability ALB
    // can't do (or degrades without opt-in). Never a silent drop.
    const result = negotiate(plan, this, { degrade: ctx.degrade });
    if (result.errors.length > 0) {
      throw new HostingError('CapabilityNotSupportedError', {
        message: formatNegotiationErrors(this.service, result),
        resolution:
          'Choose a front door that supports these capabilities (e.g. CloudFront), or accept the ' +
          'degraded behavior explicitly by listing the capability in `degrade`.',
      });
    }
    for (const w of result.warnings) {
      process.stderr.write(
        `⚠️  Hosting(alb): capability '${w.capability}' runs in a degraded form on ALB (accepted via \`degrade\`).\n`,
      );
    }

    const alb = new AlbConstruct(scope, 'Alb', {
      plan,
      bucket: ctx.bucket,
      computeFunctions: ctx.computeFunctions,
      serverComputeName: ctx.serverComputeName,
      imageComputeName: ctx.imageComputeName,
      vpc: ctx.vpc,
      internal: ctx.internal,
      certificate: ctx.certificate,
      backendApiUrl: ctx.backendApiUrl,
    });
    return { url: alb.url };
  }
}
