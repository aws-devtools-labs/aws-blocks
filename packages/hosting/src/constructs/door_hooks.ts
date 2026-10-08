/**
 * Front-door hooks — "support from implementation".
 *
 * A front door is a set of BUILD HOOKS. There is no separate capability
 * declaration: **defining a hook is what declares support**, and each hook
 * returns the flavor it actually built. What a door claims and what it builds
 * are the same code, so the two can't drift.
 *
 *   - Required core — `create` builds the door resource, `route` does all
 *     routing (static assets, SSR, images, redirects, error pages …) and REPORTS
 *     what it delivered ({@link RouteReport}), `handle` returns the public URL +
 *     attach point.
 *   - Optional feature hooks — the features that stand alone (same-origin API,
 *     custom domain, WAF, geo restriction, access logs, alarms). A missing hook
 *     means unsupported; a present hook is called ONLY when the app demands it.
 *
 * {@link runFrontDoor} drives a door at synth:
 *   1. presence — every demanded hook-backed capability needs its hook (checked
 *      BEFORE anything is built, so the error is immediate);
 *   2. build — `create` → `route` → the demanded feature hooks → `handle`;
 *   3. reports — what `route` and the hooks returned is compared with what the
 *      app demands (e.g. the app streams but `route` reported `'buffered'`).
 * Unmet demands fail synth unless waived (`degrade`) or relaxed (`negotiation`).
 * Synth only builds objects in memory, so a failure after step 2 still deploys
 * nothing.
 *
 * Every built-in door (CloudFront, ALB, API Gateway, S3 website, the CloudFront
 * edge of the stacked door) is defined with these hooks, and a customer's door
 * (`frontDoor: { kind: 'custom', door }`) is the same shape.
 */
import type { Construct } from 'constructs';
import { CAPABILITY_DEMAND, requiredCapabilities } from '../plan/negotiate.js';
import type { AdapterContext, BackendPlan, CapabilityId, CapabilityPlan } from '../plan/types.js';
import type { ChildHandles, LayerHandle } from './layer.js';
import { type NegotiationMode, resolveNegotiationMode, settleUnmetCapabilities } from './negotiation_policy.js';

/**
 * What a door's `route()` actually delivered for the routing-level capabilities
 * — the ones that configure the same routing artifact (a CloudFront behavior, an
 * ordered list of ALB rules) and so can't be split into separate hooks. An
 * omitted field means "not delivered".
 */
export type RouteReport = {
  /** Server rendering: `false`/omitted = none, else how responses are delivered. */
  ssr?: false | 'buffered' | 'streaming';
  /** Image-optimization requests are routed to the image compute. */
  images?: boolean;
  /** The plan's redirects are applied. */
  redirects?: boolean;
  /** Custom / branded error pages are served. */
  errorPages?: boolean;
  /** Responses are cached at the door. */
  cache?: boolean;
  /** The plan's per-route response headers are injected. */
  responseHeaders?: boolean;
  /** One build's assets are served consistently across a deploy (build-id cutover). */
  atomicRelease?: boolean;
  /** A user is pinned to one build during a deploy (skew protection). */
  pinSession?: boolean;
};

/** The optional feature hooks — a present hook declares support. */
export type FeatureHookName = 'sameOriginApi' | 'customDomain' | 'waf' | 'restrictGeo' | 'accessLogs' | 'alarms';

/** Execution order of the feature hooks (after `route`, before `handle`). */
const FEATURE_HOOKS: readonly FeatureHookName[] = [
  'sameOriginApi',
  'customDomain',
  'waf',
  'restrictGeo',
  'accessLogs',
  'alarms',
];

/**
 * A front door, defined by its build hooks. `TDoor` is the door's own state
 * (whatever `create` returns — a construct, or a builder the later hooks
 * configure); `TCtx` is the render context it reads (CDK handles the framework
 * already built: bucket, compute, certificate, …).
 *
 * @experimental The hooks contract may change before it is declared stable.
 */
export interface FrontDoorHooks<TDoor = unknown, TCtx extends AdapterContext = AdapterContext> {
  /** Stable id for diagnostics and error messages (e.g. `cloudfront`, `alb`, `my-edge`). */
  readonly service: string;

  // ── Required core ──────────────────────────────────────────────────────────
  /**
   * Create the door resource. `children` carries already-rendered layers below
   * this one (stacked doors), keyed by the path they front.
   */
  create(scope: Construct, ctx: TCtx, children?: ChildHandles): TDoor;
  /**
   * Do all routing for the plan (paths → bucket / SSR compute / image compute,
   * redirects, error pages, caching, headers) and REPORT what was delivered.
   * Throw here for an app-specific limit the door can't serve (it has the plan).
   */
  route(door: TDoor, plan: CapabilityPlan, ctx: TCtx): RouteReport;
  /** Return the public `url` (root layer) and the `originHandle` a parent attaches to. */
  handle(door: TDoor, ctx: TCtx): LayerHandle;

  // ── Optional feature hooks: defining one declares support ──────────────────
  /** Proxy the backend API same-origin (`/aws-blocks/*`). Report whether per-namespace routing is supported. */
  sameOriginApi?(door: TDoor, backend: BackendPlan, ctx: TCtx): 'single' | 'namespaced';
  /** Custom domain + TLS. */
  customDomain?(door: TDoor, ctx: TCtx): void;
  /** Request filtering (WAF). Report the web ACL scope that was attached. */
  waf?(door: TDoor, ctx: TCtx): 'edge' | 'regional';
  /** Geo restriction. */
  restrictGeo?(door: TDoor, ctx: TCtx): void;
  /** Access logs. */
  accessLogs?(door: TDoor, ctx: TCtx): void;
  /** Alarms on the door's metrics. */
  alarms?(door: TDoor, ctx: TCtx): void;
}

/**
 * Define a front door from its hooks. An identity helper that gives the object
 * literal full type inference (`TDoor` flows from `create` into every hook).
 *
 * @example
 * export const myEdgeDoor = defineFrontDoor({
 *   service: 'my-edge',
 *   create(scope, ctx) { return new MyCdn(scope, 'Cdn', { bucket: ctx.bucket }); },
 *   route(cdn, plan) { cdn.routeAll(plan); return { ssr: 'buffered', redirects: true }; },
 *   handle: (cdn) => ({ url: cdn.url, originHandle: { domainName: cdn.domainName, protocol: 'https' } }),
 *   customDomain(cdn, ctx) { cdn.addDomain(ctx.domain); },
 *   waf(cdn) { cdn.attachWebAcl(); return 'regional'; },
 *   // no restrictGeo / accessLogs / alarms hooks → those are unsupported
 * });
 */
export function defineFrontDoor<TDoor, TCtx extends AdapterContext = AdapterContext>(
  hooks: FrontDoorHooks<TDoor, TCtx>,
): FrontDoorHooks<TDoor, TCtx> {
  return hooks;
}

/** How a capability is delivered under the hooks model. */
export type CapabilitySource =
  /** Delivered by the required core itself (every door routes and serves assets). */
  | { kind: 'core' }
  /** Delivered when `route()` reports it. */
  | { kind: 'report'; delivered: (report: RouteReport) => boolean }
  /** Delivered by an optional feature hook (its presence is the declaration). */
  | { kind: 'hook'; hook: FeatureHookName; delivered?: (result: unknown) => boolean };

/**
 * Where each capability comes from. A `Record` over {@link CapabilityId}, so the
 * compiler forces every new capability to name its hook or report field — a
 * capability can't be added without saying how a door delivers it.
 */
export const CAPABILITY_SOURCE: Record<CapabilityId, CapabilitySource> = {
  RouteRequest: { kind: 'core' },
  ServeStaticAsset: { kind: 'core' },
  RunServerRender: { kind: 'report', delivered: (r) => r.ssr === 'buffered' || r.ssr === 'streaming' },
  StreamServerRender: { kind: 'report', delivered: (r) => r.ssr === 'streaming' },
  OptimizeImage: { kind: 'report', delivered: (r) => r.images === true },
  Redirect: { kind: 'report', delivered: (r) => r.redirects === true },
  ServeErrorPage: { kind: 'report', delivered: (r) => r.errorPages === true },
  CacheResponses: { kind: 'report', delivered: (r) => r.cache === true },
  InjectResponseHeaders: { kind: 'report', delivered: (r) => r.responseHeaders === true },
  AtomicRelease: { kind: 'report', delivered: (r) => r.atomicRelease === true },
  PinSession: { kind: 'report', delivered: (r) => r.pinSession === true },
  ProxySameOriginApi: { kind: 'hook', hook: 'sameOriginApi' },
  RouteApiNamespace: { kind: 'hook', hook: 'sameOriginApi', delivered: (res) => res === 'namespaced' },
  CustomDomainTls: { kind: 'hook', hook: 'customDomain' },
  FilterRequests: { kind: 'hook', hook: 'waf' },
  RestrictGeo: { kind: 'hook', hook: 'restrictGeo' },
  AccessLogging: { kind: 'hook', hook: 'accessLogs' },
  Alarms: { kind: 'hook', hook: 'alarms' },
};

/** Options for {@link runFrontDoor}. */
export type RunFrontDoorOptions = {
  /** Capabilities the app waives — deploy without them (else they fail in `strict`). */
  degrade?: CapabilityId[];
  /** How strictly the check is enforced. @default 'strict' */
  negotiation?: NegotiationMode;
  /** Already-rendered child layers (stacked doors), passed to `create`. */
  children?: ChildHandles;
  /** Override the demanded set (default: inferred from the plan's demand signals). */
  required?: Iterable<CapabilityId>;
  /** Error code thrown in `strict` mode. @default 'UnsupportedFrontDoorError' */
  errorCode?: string;
  /** Actionable resolution text for the `strict` error. */
  resolution?: string;
};

/** The outcome of {@link runFrontDoor}. */
export type FrontDoorRun<TDoor = unknown> = {
  /** The door's public URL + attach point. */
  handle: LayerHandle;
  /** The door's own state, as returned by `create` (e.g. the construct it built). */
  door: TDoor;
  /** What `route` reported. */
  report: RouteReport;
  /** Demanded capabilities the door delivered. */
  delivered: ReadonlySet<CapabilityId>;
  /** Demanded capabilities the door did NOT deliver (waived, warned, or unchecked). */
  unmet: readonly CapabilityId[];
};

const DEFAULT_RESOLUTION =
  "Add the missing hook (or report the capability from `route`), waive it via `frontDoor.degrade`, relax the check via `frontDoor.negotiation`, or choose a different front door.";

/** The demanded capabilities a feature hook serves. */
const capabilitiesOf = (hook: FeatureHookName): CapabilityId[] =>
  (Object.keys(CAPABILITY_SOURCE) as CapabilityId[]).filter((cap) => {
    const s = CAPABILITY_SOURCE[cap];
    return s.kind === 'hook' && s.hook === hook;
  });

/**
 * Check, build, and verify a front door from its hooks (see the module doc for
 * the three steps). Returns the handle plus what was delivered.
 *
 * @throws HostingError(`errorCode`) in `strict` mode when a demanded capability
 *   has no hook (before building) or isn't reported as delivered (after).
 * @throws HostingError('InvalidPropsError') for an unknown `negotiation` mode.
 */
export function runFrontDoor<TDoor, TCtx extends AdapterContext>(
  scope: Construct,
  plan: CapabilityPlan,
  door: FrontDoorHooks<TDoor, TCtx>,
  ctx: TCtx,
  opts: RunFrontDoorOptions = {},
): FrontDoorRun<TDoor> {
  const mode = resolveNegotiationMode(opts.negotiation, door.service);
  const required = new Set<CapabilityId>(opts.required ?? requiredCapabilities(plan));
  const settle = (unmet: CapabilityId[]): void => {
    if (mode === 'off' || unmet.length === 0) return;
    settleUnmetCapabilities(door.service, unmet, {
      mode,
      degrade: opts.degrade,
      errorCode: opts.errorCode ?? 'UnsupportedFrontDoorError',
      resolution: opts.resolution ?? DEFAULT_RESOLUTION,
    });
  };
  if (mode === 'off') {
    process.stderr.write(
      `⚠️  Hosting(${door.service}): capability check disabled (\`negotiation: 'off'\`) — the door owns correctness.\n`,
    );
  }

  // 1. Presence — a demanded hook-backed capability needs its hook. Checked
  //    before anything is built so the failure is immediate and cheap.
  const missingHook = [...required].filter((cap) => {
    const s = CAPABILITY_SOURCE[cap];
    return s.kind === 'hook' && typeof door[s.hook] !== 'function';
  });
  settle(missingHook);

  // 2. Build — create → route → the demanded feature hooks (in a fixed order) → handle.
  const state = door.create(scope, ctx, opts.children);
  const report: RouteReport = door.route(state, plan, ctx) ?? {};
  const hookResults = new Map<FeatureHookName, unknown>();
  for (const name of FEATURE_HOOKS) {
    const demanded = capabilitiesOf(name).some((cap) => required.has(cap));
    if (!demanded) continue;
    if (name === 'sameOriginApi') {
      if (door.sameOriginApi && plan.backend) hookResults.set(name, door.sameOriginApi(state, plan.backend, ctx));
      continue;
    }
    const hook = door[name];
    if (typeof hook === 'function') hookResults.set(name, hook.call(door, state, ctx) ?? true);
  }

  // 3. Reports — compare what was built with what the app demands.
  const delivered = new Set<CapabilityId>();
  for (const cap of required) {
    const s = CAPABILITY_SOURCE[cap];
    const ok =
      s.kind === 'core'
        ? true
        : s.kind === 'report'
          ? s.delivered(report)
          : hookResults.has(s.hook) && (s.delivered ? s.delivered(hookResults.get(s.hook)) : true);
    if (ok) delivered.add(cap);
  }
  const missing = new Set(missingHook);
  const unreported = [...required].filter((cap) => !delivered.has(cap) && !missing.has(cap));
  settle(unreported);

  const handle = door.handle(state, ctx);
  return {
    handle,
    door: state,
    report,
    delivered,
    unmet: [...required].filter((cap) => !delivered.has(cap)),
  };
}

/** Every capability in the vocabulary (the demand registry is the source of truth). */
export const ALL_CAPABILITIES = Object.keys(CAPABILITY_DEMAND) as CapabilityId[];
