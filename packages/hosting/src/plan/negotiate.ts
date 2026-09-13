/**
 * Capability negotiation — the conscious-degradation contract.
 *
 * Given a {@link CapabilityPlan} and a {@link FrontDoorAdapter}, decide whether
 * the chosen front door can serve the deploy, and how. The rule (see the revamp
 * design docs):
 *   - a REQUIRED capability the adapter marks `unsupported` → hard error.
 *   - a REQUIRED capability the adapter marks `degraded` → error UNLESS the app
 *     explicitly opted into degrading it, in which case a warning.
 *   - `core` / `extended` → fine, silent.
 *
 * This is what makes "some capabilities degrade per service" EXPLICIT rather
 * than a silent `if (!cloudfront) skip`.
 */
import type { CapabilityId, CapabilityPlan, FrontDoorAdapter } from './types.js';

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
  // Router payload/timeout budgets (API GW 29s/10MB, ALB-Lambda 1MB) — required
  // only when the app declares the need, so a capping door is caught not silent.
  LongRequest: (p) => p.backend?.needsLongRequests === true,
  LargePayload: (p) => p.backend?.needsLargePayloads === true,
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
  /** Capabilities that block the deploy (required + unsupported, or required + degraded without opt-in). */
  errors: Array<{ capability: CapabilityId; tier: 'unsupported' | 'degraded' }>;
  /** Capabilities that work but in a lesser form the app opted into. */
  warnings: Array<{ capability: CapabilityId }>;
};

/** Options for {@link negotiate}. */
export type NegotiateOptions = {
  /** Override the inferred required set. */
  required?: Iterable<CapabilityId>;
  /** Capabilities the app explicitly accepts in degraded form. */
  degrade?: Iterable<CapabilityId>;
};

/**
 * Negotiate a plan against an adapter. Pure — returns the errors/warnings; the
 * caller decides how to surface them (a synth-time construct throws on errors,
 * emits warnings). Never silently drops a capability.
 */
export const negotiate = (
  plan: CapabilityPlan,
  adapter: FrontDoorAdapter,
  options: NegotiateOptions = {},
): NegotiationResult => {
  const required = new Set<CapabilityId>(options.required ?? requiredCapabilities(plan));
  const degradeOk = new Set<CapabilityId>(options.degrade ?? []);
  const errors: NegotiationResult['errors'] = [];
  const warnings: NegotiationResult['warnings'] = [];

  for (const capability of required) {
    const tier = adapter.supports(capability);
    if (tier === 'unsupported') {
      errors.push({ capability, tier });
    } else if (tier === 'degraded') {
      if (degradeOk.has(capability)) warnings.push({ capability });
      else errors.push({ capability, tier });
    }
  }
  return { errors, warnings };
};

/** Format a {@link NegotiationResult}'s errors into an actionable message. */
export const formatNegotiationErrors = (service: string, result: NegotiationResult): string => {
  const lines = result.errors.map(({ capability, tier }) =>
    tier === 'unsupported'
      ? `  • ${capability}: not available on '${service}'.`
      : `  • ${capability}: only available in a degraded form on '${service}' — pass it in \`degrade\` to accept that, or choose a different front door.`,
  );
  return `Front door '${service}' cannot serve this deploy:\n${lines.join('\n')}`;
};
