/**
 * `renderGraph` — materialize a {@link FrontDoorGraph} by dispatching each node
 * to its {@link FrontDoorLayerAdapter}. This is where composed layers get
 * "hooked together": the renderer walks the graph and wires each layer to what
 * sits below it.
 *
 * Renders both single-layer graphs and NESTED compositions: a forward whose
 * target is itself a {@link FrontDoorLayer} (edge → router stacking, e.g.
 * CloudFront → ALB) is rendered bottom-up — children first, then the parent with
 * those child handles so it can attach to each child's `originHandle`. The
 * CloudFront default (no children) path is still rendered directly by the L3
 * (untouched, byte-identical); this renderer drives the non-CloudFront doors and
 * any nested composition.
 */
import type { Construct } from 'constructs';
import { HostingError } from '../hosting_error.js';
import { isOriginRef } from '../plan/types.js';
import type { AdapterContext, CapabilityPlan, FrontDoorGraph, FrontDoorLayer } from '../plan/types.js';
import { AlbAdapter } from './alb_adapter.js';
import { ApiGatewayAdapter } from './apigw_adapter.js';
import { CloudFrontAdapter } from './cloudfront_adapter.js';
import type { ChildHandles, FrontDoorLayerAdapter, LayerHandle } from './layer.js';
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
  return renderNode(scope, graph.root, plan, ctx);
}

/**
 * Render one node depth-first, bottom-up: render each nested-layer child first
 * (so it exposes an {@link OriginHandle}), then render this layer with those
 * child handles so it can attach to them. `ctx` is threaded to children as-is
 * for now (the L3 supplies a ctx superset covering every layer's needs);
 * per-node contexts are a later refinement.
 */
function renderNode(scope: Construct, node: FrontDoorLayer, plan: CapabilityPlan, ctx: AdapterContext): LayerHandle {
  const make = LAYER_ADAPTERS[node.service];
  if (!make) {
    throw new HostingError('UnsupportedFrontDoorError', {
      message: `Unknown front-door layer service '${node.service}'.`,
      resolution: "Use a known service: 'cloudfront' | 'alb' | 'api-gateway' | 's3-website'.",
    });
  }

  // Bottom-up: render nested-layer children first, keyed by their `match`.
  const children = new Map<string, LayerHandle>();
  for (const f of node.forwards) {
    if (!isOriginRef(f.to)) children.set(f.match, renderNode(scope, f.to, plan, ctx));
  }
  const childHandles: ChildHandles | undefined = children.size > 0 ? children : undefined;

  return make().renderLayer(scope, plan, ctx, childHandles);
}
