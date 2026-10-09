/**
 * `composeGraph` — build the service-agnostic {@link FrontDoorGraph} for a
 * deployment from its {@link CapabilityPlan} and the chosen front door.
 *
 * The front door is expressed as a tree of layers rather than a single
 * mutually-exclusive door. It is PURE and imports no `aws-cdk-lib` — the graph is
 * data; `renderGraph` consumes it to materialize the front door.
 *
 * A single-door choice maps to a one-node graph; a nested composition (e.g. a
 * CloudFront edge over an ALB router, via {@link composeCloudFrontOverRouter}) is
 * a multi-node graph — both are expressed by the {@link FrontDoorGraph} type.
 */
import type { CapabilityPlan, FrontDoorGraph, FrontDoorLayer, OriginRef } from './types.js';

/** Default path the backend/API subtree is routed under (matches the RPC path nomenclature). */
const API_SUBTREE_PATTERN = '/aws-blocks/api/*';

/** The front-door services a graph can be composed onto (the current door kinds). */
export type FrontDoorChoice = 'cloudfront' | 's3-website' | 'alb' | 'api-gateway';

/** Map a plan {@link CapabilityPlan.origins} kind to its neutral forward selector. */
const SELECTOR_FOR_KIND: Record<'static' | 'server' | 'image', string> = {
  static: 'static',
  server: 'server',
  image: 'image',
};

/** Forwards to the plan's own origins (S3 / server / image), most-specific concerns aside. */
const originForwards = (plan: CapabilityPlan): FrontDoorLayer['forwards'] =>
  plan.origins.map((o) => ({
    match: SELECTOR_FOR_KIND[o.kind],
    to: { kind: 'plan-origin', originId: o.id } satisfies OriginRef,
  }));

/** Forwards to the backend/API ingresses (same-origin routing), if any. */
const backendForwards = (plan: CapabilityPlan): FrontDoorLayer['forwards'] =>
  (plan.backend?.origins ?? []).map((b) => ({
    match: `api:${b.namespace}`,
    to: { kind: 'external', url: b.ingress.url } satisfies OriginRef,
  }));

/**
 * Compose the {@link FrontDoorGraph} for a plan + chosen front door.
 *
 * - `cloudfront` → an **edge** over the plan's origins + backend (the current
 *   CF-over-many-origins shape; a static-only plan yields CF → S3 alone).
 * - `alb` / `api-gateway` → a **router** over the same origins + backend.
 * - `s3-website` → a single-**origin** front (static only; no backend routing —
 *   the client reaches the API cross-origin).
 *
 * Every result here is a one-node graph. Nested compositions (an edge whose
 * child is a router) are produced by {@link composeCloudFrontOverRouter}; the
 * type already allows a `to` that is itself a {@link FrontDoorLayer}.
 */
export const composeGraph = (plan: CapabilityPlan, choice: FrontDoorChoice): FrontDoorGraph => {
  const origins = originForwards(plan);
  const backend = backendForwards(plan);

  switch (choice) {
    case 'cloudfront':
      return { root: { service: 'cloudfront', role: 'edge', forwards: [...origins, ...backend] } };
    case 'alb':
    case 'api-gateway':
      return { root: { service: choice, role: 'router', forwards: [...origins, ...backend] } };
    case 's3-website':
      // Single-origin front: static only, no backend routing (cross-origin API).
      return {
        root: {
          service: choice,
          role: 'origin',
          forwards: origins.filter((f) => f.match === 'static'),
        },
      };
  }
};

/**
 * Compose a NESTED graph representation: a CloudFront edge plus a child `router`
 * layer (e.g. `alb`) it forwards the backend/API subtree to.
 *
 * NOTE: this is the graph-layer *representation* of the nested composition. The
 * user-facing `frontDoor: { kind: 'stacked', edge: 'cloudfront', router: 'alb' }` door is realized
 * directly in `core.Hosting` (`addCloudFrontOverAlb`): CloudFront's single origin
 * is a full ALB router that routes to everything.
 */
export const composeCloudFrontOverRouter = (plan: CapabilityPlan, router: 'alb' | 'api-gateway'): FrontDoorGraph => {
  const routerNode: FrontDoorLayer = {
    service: router,
    role: 'router',
    forwards: [...originForwards(plan), ...backendForwards(plan)],
  };
  return {
    root: {
      service: 'cloudfront',
      role: 'edge',
      forwards: [...originForwards(plan), { match: API_SUBTREE_PATTERN, to: routerNode }],
    },
  };
};
