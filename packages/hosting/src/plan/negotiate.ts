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

/** Which capabilities a plan REQUIRES, inferred from its shape. */
export const requiredCapabilities = (plan: CapabilityPlan): Set<CapabilityId> => {
  const req = new Set<CapabilityId>();
  // Routing + static serving are always needed.
  req.add('RouteRequest');
  req.add('ServeStaticAsset');
  // Atomic release (build-id cutover / invalidation) guards a COMPUTE origin
  // serving cacheable HTML that references build-prefixed assets (the stale-HTML
  // → 403 problem). A pure-static deploy has no such risk, so it is only
  // required when there is a server — letting simplest static doors (e.g. an
  // S3 website bucket) negotiate cleanly without an atomicity opt-in.
  if (plan.policies.hasServer) {
    req.add('AtomicRelease');
    req.add('RunServerRender');
  }
  if (plan.origins.some((o) => o.kind === 'image')) req.add('OptimizeImage');
  if (plan.policies.skewEnabled) req.add('PinSession');
  if (plan.routes.headers.length > 0) req.add('InjectResponseHeaders');
  // Backend/API routing. Present only when the front door proxies the API
  // same-origin (undefined = cross-origin, needs no front-door support).
  if (plan.backend && plan.backend.origins.length > 0) {
    // Proxying the API subtree same-origin (cookies flow, no CORS).
    req.add('ProxySameOriginApi');
    // Path-routing DISTINCT namespaces to distinct computes is the multi-compute
    // case — a single `'*'` origin (single-compute) does not need it. A door that
    // serves one origin (function-url) can proxy but cannot path-route.
    if (plan.backend.origins.some((o) => o.namespace !== '*')) req.add('RouteApiNamespace');
    // Payload/timeout budgets the router itself imposes (API Gateway 29 s / 10 MB,
    // ALB-Lambda 1 MB). Required only when the app declares it needs them, so the
    // negotiator rejects/degrades a capping door instead of the limit surfacing
    // as a production surprise.
    if (plan.backend.needsLongRequests) req.add('LongRequest');
    if (plan.backend.needsLargePayloads) req.add('LargePayload');
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
