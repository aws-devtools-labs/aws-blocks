/**
 * `composeGraph` — build the service-agnostic {@link FrontDoorGraph} for a
 * deployment from its {@link CapabilityPlan} and the chosen front door.
 *
 * This is the "compose, don't select" step (hosting-revamp 06): the front door
 * is expressed as a tree of layers rather than a single mutually-exclusive door.
 * It is PURE and imports no `aws-cdk-lib` — the graph is data.
 *
 * NOTE (Commit 1 — representation only): the produced graph is not rendered yet
 * (the L3 deploy path is unchanged). Every current door maps to a degenerate
 * one-node graph here; nested compositions (e.g. CloudFront edge → ALB router)
 * are expressible by the {@link FrontDoorGraph} type and are added in a later
 * commit. This function exists so the topology has a single, tested source of
 * truth the renderer will consume.
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
 * child is a router) are produced in a later commit; the type already allows a
 * `to` that is itself a {@link FrontDoorLayer}.
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
 * Compose a NESTED graph: a CloudFront edge fronting the plan's static origins
 * directly, plus a child `router` layer (e.g. `alb`) it routes the backend/API
 * subtree to — the CF → ALB → compute shape (composition, not a single door).
 *
 * The edge keeps static/server/image on itself and forwards the API subtree to
 * the router child; the router carries the backend origins. `renderGraph`
 * renders the router first, then attaches the edge to its `originHandle`.
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
