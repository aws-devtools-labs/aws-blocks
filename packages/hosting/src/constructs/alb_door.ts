/**
 * ALB front door, defined with hooks — renders the same {@link CapabilityPlan}
 * as CloudFront onto an Application Load Balancer (see {@link AlbConstruct}).
 *
 * What the ALB delivers is read off its hooks, not a matrix:
 *   - `route` — listener rules route static paths to an asset-proxy Lambda (S3),
 *     SSR and image paths to their Lambdas, and applies the plan's redirects. It
 *     reports streaming SSR (ALB holds a long connection to its target), image
 *     optimization, redirects, and atomic release (build-id-prefixed keys). It
 *     does NOT report edge caching, per-route response headers, branded error
 *     pages, or session pinning — an ALB has no edge to do them.
 *   - feature hooks — same-origin API (a forwarder Lambda per namespace), custom
 *     domain (HTTPS listener), a REGIONAL WAF, native access logs, alarms on the
 *     ALB's own metrics. No `restrictGeo` hook → geo restriction is unsupported.
 *
 * `AlbConstruct` is one construct, so the hooks configure it and `handle`
 * materializes it — the output is identical to building it in one call.
 */
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import type { IVpc } from 'aws-cdk-lib/aws-ec2';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { AdapterContext, CapabilityId, CapabilityPlan } from '../plan/types.js';
import { AlbConstruct, type AlbConstructProps } from './alb_construct.js';
import { defineFrontDoor } from './door_hooks.js';
import type { NegotiationMode } from './negotiation_policy.js';

/** Context the ALB door needs beyond the plan: CDK handles + network/TLS options. */
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
  /** Capabilities the app explicitly waives — deploy without them (else the check fails). */
  degrade?: CapabilityId[];
  /** How strictly the capability check is enforced (`'strict'` default · `'warn'` · `'off'`). */
  negotiation?: NegotiationMode;
};

/** The ALB door's state: the construct props the hooks fill in, built by `handle`. */
type AlbDoorState = { scope: Construct; props: Omit<AlbConstructProps, 'plan'>; plan?: CapabilityPlan };

export const albDoor = defineFrontDoor<AlbDoorState, AlbRenderContext>({
  service: 'alb',

  create(scope, ctx) {
    return {
      scope,
      props: {
        bucket: ctx.bucket,
        computeFunctions: ctx.computeFunctions,
        serverComputeName: ctx.serverComputeName,
        imageComputeName: ctx.imageComputeName,
        vpc: ctx.vpc,
        internal: ctx.internal,
        // The listener protocol is a create-time choice: HTTPS when a cert is given.
        certificate: ctx.certificate,
      },
    };
  },

  route(door, plan) {
    door.plan = plan;
    return {
      ssr: plan.policies.hasServer ? 'streaming' : false,
      images: true,
      redirects: true,
      atomicRelease: true,
    };
  },

  handle(door, ctx) {
    if (!door.plan) throw new Error("alb door: 'route' must run before 'handle'.");
    const alb = new AlbConstruct(door.scope, 'Alb', { ...door.props, plan: door.plan });
    return {
      url: alb.url,
      originHandle: {
        domainName: alb.loadBalancer.loadBalancerDnsName,
        protocol: ctx.certificate ? 'https' : 'http',
      },
    };
  },

  // The construct routes every `plan.backend` origin — one rule per namespace.
  sameOriginApi: () => 'namespaced',
  // TLS is the HTTPS listener built from `certificate` (see `create`).
  customDomain() {},
  waf(door, ctx) {
    door.props.waf = ctx.waf;
    return 'regional';
  },
  accessLogs(door) {
    door.props.accessLogging = true;
  },
  alarms(door) {
    door.props.monitoring = true;
  },
});
