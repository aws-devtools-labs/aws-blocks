/**
 * `renderGraph` — materialize a {@link FrontDoorGraph} by dispatching each node
 * to its {@link FrontDoorLayerAdapter}. This is where composed layers get
 * "hooked together": the renderer walks the graph and wires each layer to what
 * sits below it.
 *
 * NOTE (Commit 3 — graph-driven dispatch for the non-CloudFront doors): this
 * handles the **single-layer** graphs `composeGraph` emits today (an edge/router/
 * origin over terminal origins). A forward whose target is itself a nested
 * {@link FrontDoorLayer} (true edge → router stacking, e.g. CloudFront → ALB) is
 * rejected for now — bottom-up nested rendering + the parent consuming a child's
 * `originHandle` lands in a later commit alongside the CloudFront-edge split. The
 * CloudFront default path is still rendered directly by the L3 (untouched,
 * byte-identical), so this renderer currently drives only the alb / api-gateway /
 * s3-website doors.
 */
import type { Construct } from 'constructs';
import { HostingError } from '../hosting_error.js';
import { isOriginRef } from '../plan/types.js';
import type { AdapterContext, CapabilityPlan, FrontDoorGraph } from '../plan/types.js';
import { AlbAdapter } from './alb_adapter.js';
import { ApiGatewayAdapter } from './apigw_adapter.js';
import { CloudFrontAdapter } from './cloudfront_adapter.js';
import type { FrontDoorLayerAdapter, LayerHandle } from './layer.js';
import { S3WebsiteAdapter } from './s3_website_adapter.js';

/** Service id → its layer adapter. The seam that maps a graph node to a renderer. */
const LAYER_ADAPTERS: Record<string, () => FrontDoorLayerAdapter> = {
  cloudfront: () => new CloudFrontAdapter(),
  alb: () => new AlbAdapter(),
  'api-gateway': () => new ApiGatewayAdapter(),
  's3-website': () => new S3WebsiteAdapter(),
};

/**
 * Render the graph's root layer and return its {@link LayerHandle}. `ctx` carries
 * the CDK handles the neutral graph can't (bucket, compute functions, cert, …)
 * for the root service.
 */
export function renderGraph(
  scope: Construct,
  graph: FrontDoorGraph,
  plan: CapabilityPlan,
  ctx: AdapterContext,
): LayerHandle {
  const node = graph.root;

  // Nested composition (a forward to another owned layer) is not rendered yet.
  const nestedTarget = node.forwards.map((f) => f.to).find((t) => !isOriginRef(t));
  if (nestedTarget && !isOriginRef(nestedTarget)) {
    throw new HostingError('UnsupportedFrontDoorError', {
      message: `Nested front-door composition (${node.service} → ${nestedTarget.service}) is not supported yet.`,
      resolution:
        'Use a single-layer front door for now (cloudfront, alb, api-gateway, or s3-website). ' +
        'Edge → router stacking is added in a later commit.',
    });
  }

  const make = LAYER_ADAPTERS[node.service];
  if (!make) {
    throw new HostingError('UnsupportedFrontDoorError', {
      message: `Unknown front-door layer service '${node.service}'.`,
      resolution: "Use a known service: 'cloudfront' | 'alb' | 'api-gateway' | 's3-website'.",
    });
  }
  return make().renderLayer(scope, plan, ctx);
}
