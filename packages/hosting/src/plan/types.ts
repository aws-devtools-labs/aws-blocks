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

  // ── Demand signals — each flags an app-expressed NEED, so the negotiator
  // requires the matching capability ONLY when the app asked for it. Absence of
  // an un-demanded capability is a clean fit, never a failure. Read from the
  // app's HostingProps / manifest (the demand surface), not from CloudFront.
  /** The app configured a custom domain → needs trusted TLS on that host. */
  customDomain?: boolean;
  /** The app enabled a WAF → needs request filtering. */
  wafEnabled?: boolean;
  /** The app configured access logging → needs the door to emit access logs. */
  loggingEnabled?: boolean;
  /** The app ships custom error pages → needs the door to serve them. */
  hasCustomErrorPages?: boolean;
  /** The app declared redirects (incl. www↔apex) → needs the door to perform them. */
  hasRedirects?: boolean;
  /** The app's SSR streams responses → needs streaming (not buffered). */
  needsStreaming?: boolean;
  /** The app restricted content by geography → needs geo enforcement. */
  geoRestricted?: boolean;
  /** The app configured monitoring/alarms → needs the door to emit metrics/alarms. */
  monitoringEnabled?: boolean;
  /** The app requires edge caching as a hard need (rare; perf is otherwise optional). */
  edgeCacheRequired?: boolean;
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
 * at synth, so degradation is never silent.
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
  | 'RestrictGeo'
  | 'AccessLogging'
  | 'ServeErrorPage'
  | 'Redirect'
  | 'Alarms';

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
 */
export interface FrontDoorAdapter {
  /** Stable id for diagnostics/presets (e.g. `cloudfront`, `alb`, `api-gateway`). */
  readonly service: string;
  /** Declare how well this service supports a capability. */
  supports(capability: CapabilityId): SupportTier;
  /** Materialize the service for the given plan. */
  render(scope: Construct, plan: CapabilityPlan, ctx: AdapterContext): FrontDoorResult;
}

// ── The front-door graph (composition model) ──────────────────────────────────
//
// The front door is not a single mutually-exclusive door — it is a COMPOSITION
// of layers (`edge → router → origins`). This is the neutral, service-agnostic
// data model for that composition: a tree rooted at the single public entry
// point. A layer forwards a matched request down to either a NESTED layer
// (composition — e.g. CloudFront edge in front of an ALB router) or a terminal
// {@link OriginRef}.

/** What a layer is FOR in the stack — drives negotiation and rendering order. */
export type LayerRole = 'edge' | 'router' | 'origin';

/**
 * A terminal a layer forwards to: a plan origin we own (S3 / server / image), or
 * an external endpoint we only point at (bring-your-own-compute, a compute's own
 * ingress). `reachability` distinguishes a public endpoint from a VPC-private one
 * (an internal ALB/EKS reached via a CloudFront VPC origin / API-GW VPC Link).
 */
export type OriginRef =
  | { kind: 'plan-origin'; originId: string }
  | { kind: 'external'; url: string; reachability?: 'public' | 'vpc-private' };

/** What a layer forwards a matched request to: a nested layer (composition) or a terminal origin. */
export type FrontDoorTarget = FrontDoorLayer | OriginRef;

/**
 * One provisioned layer (a node in the {@link FrontDoorGraph}). It routes matched
 * selectors DOWN to nested layers or terminal origins. A lone edge/router with
 * only {@link OriginRef} children is the common single-layer case; a `to` that is
 * itself a {@link FrontDoorLayer} is the composition case (edge → router → …).
 */
export type FrontDoorLayer = {
  /** The service that realizes this layer (`cloudfront` | `alb` | `api-gateway` | `s3-website` | …). */
  service: string;
  /** The role this layer plays. */
  role: LayerRole;
  /**
   * Where this layer forwards. `match` is a neutral selector — a route kind
   * (`static`/`server`/`image`) or an API-namespace tag (`api:<ns>`); the concrete
   * URL patterns live in {@link CapabilityPlan.routes} and are applied at render.
   */
  forwards: Array<{ match: string; to: FrontDoorTarget }>;
};

/** The whole composition — the tree rooted at the single public entry layer. */
export type FrontDoorGraph = {
  root: FrontDoorLayer;
};

/** Type guard: is a {@link FrontDoorTarget} a terminal origin (vs a nested layer)? */
export const isOriginRef = (t: FrontDoorTarget): t is OriginRef =>
  (t as OriginRef).kind === 'plan-origin' || (t as OriginRef).kind === 'external';
