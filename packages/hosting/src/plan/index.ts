/**
 * `@aws-blocks/hosting` plan layer — the service-agnostic core.
 *
 * The barrel for the Ports & Adapters seam: the {@link CapabilityPlan} contracts,
 * the neutral {@link buildRouteTable} / {@link buildCapabilityPlan} builders, and
 * the demand registry ({@link requiredCapabilities}). Nothing here imports
 * `aws-cdk-lib` or a service SDK — front-door specifics live in each door's
 * build hooks (`constructs/door_hooks.ts`).
 *
 * @module
 */
export type {
  AdapterContext,
  BackendIngress,
  BackendOrigin,
  BackendPlan,
  CapabilityId,
  CapabilityPlan,
  FrontDoorGraph,
  FrontDoorLayer,
  FrontDoorTarget,
  HeaderRule,
  LayerRole,
  Origin,
  OriginRef,
  PlanPolicies,
  RedirectRule,
  ReleasePlan,
  RouteTable,
} from './types.js';
export { isOriginRef } from './types.js';
export { composeGraph, composeCloudFrontOverRouter } from './compose.js';
export type { FrontDoorChoice } from './compose.js';
export type { RouteEntry, RouteKind } from './route-table.js';
export {
  buildRouteTable,
  coalesceRoutes,
  routeSpecificity,
  toTerseRows,
} from './route-table.js';
export type { BuildRouteTableInput, TerseRouteKind } from './route-table.js';
export { buildCapabilityPlan, ORIGIN_IDS } from './capability-plan.js';
export type { BuildCapabilityPlanInput } from './capability-plan.js';
export { CAPABILITY_DEMAND, formatNegotiationErrors, requiredCapabilities } from './negotiate.js';
export type { NegotiationResult } from './negotiate.js';
