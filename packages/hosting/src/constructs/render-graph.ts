/**
 * `renderGraph` — materialize a {@link FrontDoorGraph} by dispatching each node
 * to its hook-defined front door (see `door_hooks.ts`). This is where composed layers get
 * "hooked together": the renderer walks the graph and wires each layer to what
 * sits below it.
 *
 * Renders both single-layer graphs and NESTED compositions: a forward whose
 * target is itself a {@link FrontDoorLayer} (edge → router stacking, e.g.
 * CloudFront → ALB) is rendered bottom-up — children first, then the parent with
 * those child handles so it can attach to each child's `originHandle`. Every
 * node goes through {@link runFrontDoor}: the door's hooks are checked against
 * the plan's demands, then built.
 */
import type { Construct } from 'constructs';
import { HostingError } from '../hosting_error.js';
import { isOriginRef } from '../plan/types.js';
import type { AdapterContext, CapabilityId, CapabilityPlan, FrontDoorGraph, FrontDoorLayer } from '../plan/types.js';
import { albDoor } from './alb_door.js';
import { apiGatewayDoor } from './apigw_door.js';
import { cloudFrontDoor } from './cloudfront_door.js';
import { type FrontDoorHooks, type FrontDoorRun, runFrontDoor } from './door_hooks.js';
import type { ChildHandles, LayerHandle } from './layer.js';
import type { NegotiationMode } from './negotiation_policy.js';
import { s3WebsiteDoor } from './s3_website_door.js';

/** A built-in door + the resolution text its `strict` error carries. */
type BuiltInDoor = { door: FrontDoorHooks<unknown, never>; resolution: string };

/** Service id → its hook-defined door. The seam that maps a graph node to a renderer. */
const LAYER_DOORS: Record<string, BuiltInDoor> = {
  cloudfront: {
    door: cloudFrontDoor,
    resolution: 'Waive the missing capability via `degrade`.',
  },
  alb: {
    door: albDoor,
    resolution:
      'Choose a front door that supports these capabilities (e.g. CloudFront), or accept the ' +
      'missing capability explicitly by listing it in `degrade`.',
  },
  'api-gateway': {
    door: apiGatewayDoor,
    resolution:
      'Choose a front door that supports these capabilities (e.g. cloudfront/alb), or accept the ' +
      'missing capability explicitly by listing it in `degrade`.',
  },
  's3-website': {
    door: s3WebsiteDoor,
    resolution:
      "`frontDoor: 'none'` serves a pure static site / SPA directly from S3 (HTTP only, no " +
      'front door). For SSR, a same-origin API, image optimization, HTTPS, or atomic deploys, ' +
      "use the CloudFront default (omit `frontDoor`) or `{ kind: 'alb' }`.",
  },
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
  return renderGraphRun(scope, graph, plan, ctx).handle;
}

/** {@link renderGraph}, returning the root door's full {@link FrontDoorRun}. */
export function renderGraphRun(
  scope: Construct,
  graph: FrontDoorGraph,
  plan: CapabilityPlan,
  ctx: AdapterContext,
): FrontDoorRun {
  return renderNode(scope, graph.root, plan, ctx);
}

/**
 * Render one node depth-first, bottom-up: render each nested-layer child first
 * (so it exposes an {@link OriginHandle}), then render this layer with those
 * child handles so it can attach to them. `ctx` is threaded to children as-is
 * for now (the L3 supplies a ctx superset covering every layer's needs);
 * per-node contexts are a later refinement.
 */
function renderNode(scope: Construct, node: FrontDoorLayer, plan: CapabilityPlan, ctx: AdapterContext): FrontDoorRun {
  const builtIn = LAYER_DOORS[node.service];
  if (!builtIn) {
    throw new HostingError('UnsupportedFrontDoorError', {
      message: `Unknown front-door layer service '${node.service}'.`,
      resolution: "Use a known service: 'cloudfront' | 'alb' | 'api-gateway' | 's3-website'.",
    });
  }

  // Bottom-up: render nested-layer children first, keyed by their `match`.
  const children = new Map<string, LayerHandle>();
  for (const f of node.forwards) {
    if (!isOriginRef(f.to)) children.set(f.match, renderNode(scope, f.to, plan, ctx).handle);
  }
  const childHandles: ChildHandles | undefined = children.size > 0 ? children : undefined;

  return runFrontDoor(scope, plan, builtIn.door, ctx as never, {
    children: childHandles,
    degrade: ctx.degrade as CapabilityId[] | undefined,
    negotiation: ctx.negotiation as NegotiationMode | undefined,
    errorCode: 'CapabilityNotSupportedError',
    resolution: builtIn.resolution,
  });
}
