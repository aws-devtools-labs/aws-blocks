/**
 * `@aws-blocks/hosting` plan layer — the service-agnostic core.
 *
 * The barrel for the Ports & Adapters seam: the {@link CapabilityPlan} contracts
 * and the neutral {@link buildRouteTable} / {@link buildCapabilityPlan} builders.
 * Nothing here imports `aws-cdk-lib` or a service SDK — front-door specifics
 * live in each door's `build` (`constructs/front_door.ts`).
 *
 * @module
 */
export type {
  BackendIngress,
  BackendOrigin,
  BackendPlan,
  CapabilityPlan,
  HeaderRule,
  Origin,
  PlanPolicies,
  RedirectRule,
  ReleasePlan,
  RouteTable,
} from './types.js';
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
