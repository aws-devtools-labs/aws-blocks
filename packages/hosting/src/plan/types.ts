/**
 * Service-agnostic hosting contracts — the Ports & Adapters seam.
 *
 * The CORE computes a {@link CapabilityPlan} (what to serve) from a
 * `DeployManifest`; a {@link FrontDoorAdapter} renders that plan onto a concrete
 * service (CloudFront, ALB, API Gateway, …). Nothing in this file imports
 * `aws-cdk-lib` or any service SDK — it is pure data + interfaces, so the plan
 * layer stays free of any single front door's assumptions.
 *
 * Types only. Behaviour lives in `route-table.ts` / `capability-plan.ts` (core)
 * and in each adapter (renderers).
 */
import type { Construct } from 'constructs';
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
 * each to its service's mechanism (or declares it unsupported/degraded).
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
 * One API-namespace → ingress route. This is the neutral form of the
 * multi-compute front-door problem (see the "Multi-Compute Front Door" one-pager):
 * a request for `/aws-blocks/api/{namespace}/*` must reach the compute that owns
 * that namespace. A single `namespace: '*'` origin is the common single-compute,
 * same-origin case (the whole `/aws-blocks/*` + `/aws-blocks-auth/*` API subtree
 * proxied to one backend).
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
  /** The app needs requests longer than a router's short timeout (agent loops, big batch jobs). */
  needsLongRequests?: boolean;
  /** The app needs payloads above a router's size cap (large uploads/downloads). */
  needsLargePayloads?: boolean;
};

/**
 * The complete service-agnostic description of a deployment. Produced by the
 * core (`buildCapabilityPlan`); consumed by every {@link FrontDoorAdapter}.
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

// ── Capability negotiation (the conscious-degradation contract) ───────────────

/**
 * A hosting capability — one thing a front door may be asked to do. A service
 * adapter declares, per capability, how well it supports it (its
 * {@link SupportTier}). The negotiator uses these declarations to fail or warn
 * at synth (see the design docs), so degradation is never silent.
 */
export type CapabilityId =
  | 'RouteRequest'
  | 'ServeStaticAsset'
  | 'RunServerRender'
  | 'StreamServerRender'
  | 'ProxySameOriginApi'
  | 'RouteApiNamespace'
  | 'LongRequest'
  | 'LargePayload'
  | 'CustomDomainTls'
  | 'InjectResponseHeaders'
  | 'FilterRequests'
  | 'CacheResponses'
  | 'AtomicRelease'
  | 'PinSession'
  | 'OptimizeImage'
  | 'RestrictGeo';

/**
 * How well an adapter supports a capability.
 *   - `core`        — supported the standard way.
 *   - `extended`    — supported via a different but full mechanism.
 *   - `degraded`    — a lesser version (opt-in required, else the negotiator fails).
 *   - `unsupported` — cannot do it (required → hard synth error).
 */
export type SupportTier = 'core' | 'extended' | 'degraded' | 'unsupported';

/** Per-deploy context an adapter needs beyond the plan (CDK handles, scope, etc.). */
export type AdapterContext = {
  /** The private assets bucket name/handle is passed via the concrete adapter's own props; */
  /** this context carries only service-neutral flags added over time. */
  readonly [key: string]: unknown;
};

/** What a front-door adapter returns after rendering a plan. */
export type FrontDoorResult = {
  /** The public URL the deploy is reachable at. */
  url: string;
};

/**
 * The seam every front-door service implements. An adapter takes a
 * {@link CapabilityPlan} and materializes the service (CloudFront distribution,
 * ALB + listener rules, API Gateway, …), and declares its per-capability
 * {@link SupportTier} so the negotiator can enforce conscious degradation.
 *
 * NOTE: this is the Phase-1 contract (types only). The CloudFront renderer is
 * refactored to implement it in a later step; no adapter is wired to it yet.
 */
export interface FrontDoorAdapter {
  /** Stable id for diagnostics/presets (e.g. `cloudfront`, `alb`, `api-gateway`). */
  readonly service: string;
  /** Declare how well this service supports a capability. */
  supports(capability: CapabilityId): SupportTier;
  /** Materialize the service for the given plan. */
  render(scope: Construct, plan: CapabilityPlan, ctx: AdapterContext): FrontDoorResult;
}
