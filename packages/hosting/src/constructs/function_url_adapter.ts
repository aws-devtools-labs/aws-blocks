/**
 * Lambda Function URL front-door adapter — the cheapest HTTPS, no-CloudFront
 * door for a static site / SPA. Renders the same {@link CapabilityPlan} onto a
 * single asset-proxy Lambda exposed via a Function URL (see
 * {@link FunctionUrlConstruct}).
 *
 * Single-origin, so SSR, same-origin API proxy, and per-route routing are
 * `unsupported` — the negotiator fails synth (conscious) if a plan requires
 * them, steering multi-origin apps to `api-gateway`/`alb`/`cloudfront`.
 */
import type { Construct } from 'constructs';
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
import { FunctionUrlConstruct } from './function_url_construct.js';

/** Function URL's per-capability support (single-origin, static/SPA only). */
const FUNCTION_URL_SUPPORT: Record<CapabilityId, SupportTier> = {
  RouteRequest: 'extended', // single origin: asset-proxy does SPA fallback, no multi-origin routing
  ServeStaticAsset: 'extended', // asset-proxy Lambda → private S3
  RunServerRender: 'unsupported', // one origin can't also serve static assets
  StreamServerRender: 'unsupported',
  ProxySameOriginApi: 'unsupported', // no path routing to a backend; use api-gateway/alb
  CustomDomainTls: 'core', // built-in HTTPS (custom domain needs a fronting proxy)
  InjectResponseHeaders: 'degraded',
  FilterRequests: 'unsupported',
  CacheResponses: 'degraded',
  AtomicRelease: 'extended', // build-id prefixed S3 keys
  PinSession: 'unsupported',
  OptimizeImage: 'unsupported', // no separate image origin
  RestrictGeo: 'unsupported',
};

export type FunctionUrlRenderContext = AdapterContext & {
  bucket: IBucket;
  degrade?: CapabilityId[];
};

export class FunctionUrlAdapter implements FrontDoorAdapter {
  readonly service = 'function-url';

  supports(capability: CapabilityId): SupportTier {
    return FUNCTION_URL_SUPPORT[capability];
  }

  render(scope: Construct, plan: CapabilityPlan, ctx: FunctionUrlRenderContext): FrontDoorResult {
    const result = negotiate(plan, this, { degrade: ctx.degrade });
    if (result.errors.length > 0) {
      throw new HostingError('CapabilityNotSupportedError', {
        message: formatNegotiationErrors(this.service, result),
        resolution:
          'The Function URL door serves static sites / SPAs only. For SSR, a same-origin API, ' +
          'or image optimization, use { kind: "api-gateway" | "alb" } or the CloudFront default.',
      });
    }
    for (const w of result.warnings) {
      process.stderr.write(
        `⚠️  Hosting(function-url): capability '${w.capability}' runs in a degraded form (accepted via \`degrade\`).\n`,
      );
    }
    const fu = new FunctionUrlConstruct(scope, 'FunctionUrl', { plan, bucket: ctx.bucket });
    return { url: fu.url };
  }
}
