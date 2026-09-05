/**
 * `@aws-blocks/hosting` plan layer — the service-agnostic core.
 *
 * The barrel for the Ports & Adapters seam: the {@link CapabilityPlan} contracts,
 * the neutral {@link buildRouteTable} / {@link buildCapabilityPlan} builders, and
 * the {@link FrontDoorAdapter} interface. Nothing here imports `aws-cdk-lib` or a
 * service SDK — front-door specifics live in each adapter (renderer).
 *
 * @module
 */
export type {
  AdapterContext,
  CapabilityId,
  CapabilityPlan,
  FrontDoorAdapter,
  FrontDoorResult,
  HeaderRule,
  Origin,
  PlanPolicies,
  RedirectRule,
  ReleasePlan,
  RouteTable,
  SupportTier,
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
export { formatNegotiationErrors, negotiate, requiredCapabilities } from './negotiate.js';
export type { NegotiateOptions, NegotiationResult } from './negotiate.js';
