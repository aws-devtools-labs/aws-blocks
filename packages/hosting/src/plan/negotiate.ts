/**
 * Capability negotiation — the conscious-degradation contract.
 *
 * This module owns the DEMAND side: which capabilities a {@link CapabilityPlan}
 * requires. The SUPPLY side is read off the door's build hooks (a present hook,
 * or a `route()` report — see `constructs/door_hooks.ts`), never a separate
 * declaration. The rule:
 *   - a REQUIRED capability the door delivers → fine, silent.
 *   - a REQUIRED capability the door doesn't deliver → error UNLESS the app
 *     explicitly waived it via `degrade`, in which case a warning.
 *
 * This is what makes "some capabilities are missing per service" EXPLICIT rather
 * than a silent `if (!cloudfront) skip`. The door-wide escape hatch
 * (`negotiation: 'warn' | 'off'`) is applied by the caller on top of this.
 */
import type { CapabilityId, CapabilityPlan } from './types.js';

/**
 * The DEMAND registry — the single source of truth for "does this app need this
 * capability?". A capability is REQUIRED iff its predicate is true for the plan;
 * otherwise its absence is a clean fit, NOT a degradation (that is the whole
 * point — we never fail a build for a capability the app didn't ask for).
 *
 * Demand is read from the plan (which reflects the app's manifest + Hosting
 * props — the demand surface), never from what a given service happens to
 * implement. Every {@link CapabilityId} MUST have an entry here; the
 * completeness test enforces it, so a new capability can't be added without
 * declaring when it is demanded (this is what stopped features like access
 * logging from silently slipping past the negotiator).
 *
 * Three demand shapes:
 *  - always-on hard needs (`RouteRequest`, `ServeStaticAsset`);
 *  - conditional hard needs (SSR, custom-domain TLS, image-opt, same-origin API…)
 *    — required only when the plan shows the app uses them;
 *  - opt-in security/compliance (WAF, logging, geo) — required only when the app
 *    turned them on (then satisfiable by a supporting door or an explicit
 *    `degrade`).
 * Pure perf/optional features (compression, HTTP/3, price class) are NOT
 * capabilities — see the CF-only allowlist — so they can never fail a build.
 */
export const CAPABILITY_DEMAND: Record<CapabilityId, (plan: CapabilityPlan) => boolean> = {
  // Always needed by any site.
  RouteRequest: () => true,
  ServeStaticAsset: () => true,
  // Conditional hard needs — required only when the app actually uses them.
  RunServerRender: (p) => p.policies.hasServer,
  // Build-id cutover / invalidation guards a COMPUTE origin serving cacheable
  // HTML referencing build-prefixed assets (stale-HTML→403). Pure-static has no
  // such risk, so static doors negotiate clean without an atomicity opt-in.
  AtomicRelease: (p) => p.policies.hasServer,
  StreamServerRender: (p) => p.policies.needsStreaming === true,
  OptimizeImage: (p) => p.origins.some((o) => o.kind === 'image'),
  PinSession: (p) => p.policies.skewEnabled,
  InjectResponseHeaders: (p) => p.routes.headers.length > 0,
  CustomDomainTls: (p) => p.policies.customDomain === true,
  ServeErrorPage: (p) => p.policies.hasCustomErrorPages === true,
  Redirect: (p) => p.policies.hasRedirects === true,
  // Backend/API routing — only when the door proxies the API same-origin.
  ProxySameOriginApi: (p) => (p.backend?.origins.length ?? 0) > 0,
  // Path-routing DISTINCT namespaces (multi-compute); a lone `'*'` doesn't need it.
  RouteApiNamespace: (p) => p.backend?.origins.some((o) => o.namespace !== '*') ?? false,
  // Opt-in security / compliance — required only when the app turned them on.
  FilterRequests: (p) => p.policies.wafEnabled === true,
  RestrictGeo: (p) => p.policies.geoRestricted === true,
  AccessLogging: (p) => p.policies.loggingEnabled === true,
  Alarms: (p) => p.policies.monitoringEnabled === true,
  // Edge caching is a hard need only if the app explicitly requires it; otherwise
  // it is a perf optimization whose absence is a clean fit.
  CacheResponses: (p) => p.policies.edgeCacheRequired === true,
};

/**
 * CloudFront-only tuning that is deliberately NOT a capability: pure
 * performance/footprint knobs whose absence on another door is optimal-vs-less,
 * never a broken use case — so they must never fail a build. Documented here so
 * the completeness test can assert they are consciously excluded, not forgotten.
 */
export const CF_ONLY_FEATURES = ['CompressResponse', 'Http3', 'PriceClass'] as const;

/** Which capabilities a plan REQUIRES — derived from the demand registry. */
export const requiredCapabilities = (plan: CapabilityPlan): Set<CapabilityId> => {
  const req = new Set<CapabilityId>();
  for (const cap of Object.keys(CAPABILITY_DEMAND) as CapabilityId[]) {
    if (CAPABILITY_DEMAND[cap](plan)) req.add(cap);
  }
  return req;
};

export type NegotiationResult = {
  /** Capabilities that block the deploy (required + not delivered, not waived via `degrade`). */
  errors: Array<{ capability: CapabilityId; tier: 'unsupported' }>;
  /** Capabilities the app waived via `degrade` — deployed without them. */
  warnings: Array<{ capability: CapabilityId }>;
};

/** Format a {@link NegotiationResult}'s errors into an actionable message. */
export const formatNegotiationErrors = (service: string, result: NegotiationResult): string => {
  const lines = result.errors.map(
    ({ capability }) =>
      `  • ${capability}: not available on '${service}' — list it in \`degrade\` to deploy without it, or choose a different front door.`,
  );
  return `Front door '${service}' cannot serve this deploy:\n${lines.join('\n')}`;
};
