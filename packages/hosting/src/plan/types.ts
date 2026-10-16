/**
 * Service-agnostic hosting contracts — the Ports & Adapters seam.
 *
 * The CORE computes a {@link CapabilityPlan} (what to serve) from a
 * `DeployManifest`; a built-in front door (see `constructs/front_door.ts`)
 * renders that plan onto a concrete service (CloudFront, ALB, API Gateway, …),
 * and the plan is also what the `DoorInput` handed to a bring-your-own door is
 * assembled from. Nothing in this file imports `aws-cdk-lib` or any service
 * SDK — it is pure data + interfaces, so the plan layer stays free of any
 * single front door's assumptions.
 *
 * Types only. Behaviour lives in `route-table.ts` / `capability-plan.ts` (core)
 * and in each front door (renderers).
 */
import type { RouteEntry } from './route-table.js';

export type { RouteEntry, RouteKind } from './route-table.js';

/** A place that produces a response. The route table selects between origins by id. */
export type Origin = {
  /** Stable id the route table references (e.g. `blocks-s3`, `blocks-server`). */
  id: string;
  /** What this origin serves. */
  kind: 'static' | 'server' | 'image';
};

/** A canonical redirect rule (basePath-resolved). */
export type RedirectRule = {
  source: string;
  destination: string;
  statusCode: 301 | 302 | 307 | 308;
};

/** A per-pattern response-header rule (basePath-resolved). */
export type HeaderRule = {
  /** URL pattern the headers apply to. */
  pattern: string;
  /** Header name → value. */
  headers: Record<string, string>;
};

/**
 * The neutral routing model: ordered route entries plus the redirect and
 * per-pattern-header rules. A renderer turns this into its own primitive
 * (CloudFront KVS + Function, ALB listener rules, API Gateway routes, …).
 */
export type RouteTable = {
  /** Ordered `{pattern, kind}` entries (most-specific first). */
  entries: RouteEntry[];
  /** Canonical redirects (first match wins). */
  redirects: RedirectRule[];
  /** Per-pattern response headers. */
  headers: HeaderRule[];
};

/**
 * Cross-cutting deployment policies — the neutral form of what today lives in
 * the CloudFront KVS `meta` blob and various construct props. A renderer maps
 * each to its service's mechanism (or leaves it out).
 */
export type PlanPolicies = {
  /** URL prefix the whole site is served under (Next `basePath` etc.), or undefined. */
  basePath?: string;
  /** Alternative asset prefix (Next `assetPrefix`), or undefined. */
  assetPrefix?: string;
  /** Image-opt path prefix (Nuxt IPX `/_ipx`), or undefined. */
  imagePrefix?: string;
  /** Single-page-app fallback (extensionless → index.html) vs directory-index. */
  spaFallback: boolean;
  /** Whether a server (compute) origin exists → default route target. */
  hasServer: boolean;
  /** apex/www canonical-redirect mode. */
  wwwRedirect?: 'toApex' | 'toWww' | 'none';
  /** Whether cookie-based skew protection is enabled. */
  skewEnabled: boolean;
};

/** Release/atomicity info for the deploy. */
export type ReleasePlan = {
  /** Immutable build id; assets live under `builds/<buildId>/`. */
  buildId: string;
};

/**
 * Where a slice of the backend/API surface is reached. Service-neutral: an
 * adapter turns it into its own primitive (a CloudFront behavior + origin, an
 * API Gateway HTTP-proxy route, an ALB forwarder-Lambda target, …).
 *
 * `kind: 'url'` — an HTTPS endpoint (a Lambda compute's API Gateway invoke URL,
 * a container's ALB DNS, or an arbitrary bring-your-own-compute URL). The union
 * is intentionally single-member today; a future `'lambda'`/`'ip'` direct-target
 * kind can be added without changing consumers that already switch on `kind`.
 */
export type BackendIngress = {
  kind: 'url';
  /** The routable HTTPS base (may be a CDK token). */
  url: string;
};

/**
 * One API-namespace → ingress route. This is the neutral form of multi-compute
 * backend routing: a request for `/aws-blocks/api/{namespace}/*` must reach the
 * compute that owns that namespace. A single `namespace: '*'` origin is the common single-compute,
 * same-origin case (the whole `/aws-blocks/*` API subtree proxied to one backend).
 */
export type BackendOrigin = {
  /** The `/aws-blocks/api/{namespace}` segment this ingress owns; `'*'` = the whole API subtree. */
  namespace: string;
  /** Where requests for this namespace are routed. */
  ingress: BackendIngress;
};

/**
 * The neutral description of how the front door routes to the backend/API. When
 * Hosting is present, its front door IS the shared door for the whole app — so
 * routing to backend resources is a first-class front-door responsibility, not a
 * CloudFront-only add-on. Absent (`undefined`) means the front door does not
 * proxy the API same-origin (the client reaches the backend cross-origin via
 * `BLOCKS_API_URL`); present means the door path-routes each namespace to its
 * owning compute's ingress.
 */
export type BackendPlan = {
  /** API-namespace → ingress routes. A lone `'*'` origin is the single-compute same-origin case. */
  origins: BackendOrigin[];
};

/**
 * The complete service-agnostic description of a deployment. Produced by the
 * core (`buildCapabilityPlan`); consumed by the built-in front doors.
 * Contains NO service types — a plan is identical whether it is later rendered
 * onto CloudFront, an ALB, or emitted as a portable bundle.
 */
export type CapabilityPlan = {
  origins: Origin[];
  routes: RouteTable;
  policies: PlanPolicies;
  release: ReleasePlan;
  /**
   * How the front door routes to the backend/API surface. Present when the door
   * proxies the API same-origin (each namespace → its owning compute's ingress);
   * `undefined` when the client reaches the backend cross-origin. See
   * {@link BackendPlan}.
   */
  backend?: BackendPlan;
};
