/**
 * S3 static-website front door, defined with hooks — the simplest/cheapest door
 * for a pure static site / SPA (public website bucket, no CloudFront, no Lambda,
 * no TLS). Renders the {@link CapabilityPlan} onto an {@link S3WebsiteConstruct}.
 *
 * It defines only the required core, and `route` reports nothing beyond static
 * routing — so SSR, same-origin API, image optimization, HTTPS, and every
 * feature hook are unsupported, and the check fails synth for anything beyond
 * static/SPA, steering those apps to a CDN/ALB/API Gateway door.
 */
import { Fn } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { AdapterContext, CapabilityId, CapabilityPlan } from '../plan/types.js';
import { defineFrontDoor } from './door_hooks.js';
import type { NegotiationMode } from './negotiation_policy.js';
import { S3WebsiteConstruct } from './s3_website_construct.js';

export type S3WebsiteRenderContext = AdapterContext & {
  /** The built static assets directory to publish. */
  staticDir: string;
  degrade?: CapabilityId[];
  /** How strictly the capability check is enforced (`'strict'` default · `'warn'` · `'off'`). */
  negotiation?: NegotiationMode;
};

type S3WebsiteDoorState = { scope: Construct; plan?: CapabilityPlan };

export const s3WebsiteDoor = defineFrontDoor<S3WebsiteDoorState, S3WebsiteRenderContext>({
  service: 's3-website',

  create: (scope) => ({ scope }),

  // Website index/error-document routing over a public bucket — static only.
  route(door, plan) {
    door.plan = plan;
    return {};
  },

  /**
   * The {@link OriginHandle} is the website endpoint host (HTTP-only — S3
   * website endpoints don't support TLS).
   */
  handle(door, ctx) {
    if (!door.plan) throw new Error("s3-website door: 'route' must run before 'handle'.");
    const site = new S3WebsiteConstruct(door.scope, 'S3Website', { plan: door.plan, staticDir: ctx.staticDir });
    return {
      url: site.url,
      originHandle: { domainName: Fn.select(1, Fn.split('://', site.url)), protocol: 'http' },
      // The public website bucket the SPA is served from — the wrapper publishes
      // config.json here (root `.blocks-sandbox/`) so the cross-origin client can
      // read the absolute API URL from the SAME origin it loads from.
      publicBucket: site.bucket,
    };
  },
});
