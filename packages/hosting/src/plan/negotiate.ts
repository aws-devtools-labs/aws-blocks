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
  req.add('AtomicRelease');
  if (plan.policies.hasServer) req.add('RunServerRender');
  if (plan.origins.some((o) => o.kind === 'image')) req.add('OptimizeImage');
  if (plan.policies.skewEnabled) req.add('PinSession');
  if (plan.routes.headers.length > 0) req.add('InjectResponseHeaders');
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
