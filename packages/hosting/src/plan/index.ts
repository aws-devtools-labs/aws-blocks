/**
 * `@aws-blocks/hosting` plan layer — the service-agnostic core.
 *
 * The barrel for the Ports & Adapters seam: the {@link HostingPlan} contracts
 * and the neutral {@link buildRouteTable} / {@link buildHostingPlan} builders.
 * Nothing here imports `aws-cdk-lib` or a service SDK — front-door specifics
 * live in each door's `build` (`constructs/front_door.ts`).
 *
 * @module
 */
export type {
  BackendIngress,
  BackendOrigin,
  BackendPlan,
  HostingPlan,
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
export { buildHostingPlan, ORIGIN_IDS } from './hosting-plan.js';
export type { BuildHostingPlanInput } from './hosting-plan.js';
