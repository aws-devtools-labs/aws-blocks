/**
 * Negotiation policy — how strictly a front door enforces the capability check.
 *
 * Every door is checked against the deploy's {@link CapabilityPlan}: a
 * capability the app DEMANDS that the door doesn't deliver fails synth by
 * default (`'strict'`) — never a silent production break. A platform that owns
 * and validates its door its own way can relax that on purpose with the
 * `negotiation` option on the `frontDoor` prop:
 *
 *   - `'strict'` (default) — unmet demands throw at synth.
 *   - `'warn'`   — unmet demands are reported as synth warnings; the deploy proceeds.
 *   - `'off'`    — the check is skipped entirely; the door owns correctness.
 *
 * `degrade` (per-capability waiver) applies in every mode. Under the hooks model
 * (see `door_hooks.ts`) "delivers" means the door DEFINES the capability's hook,
 * or its `route()` REPORTS the capability — never a separate declaration.
 */
import { HostingError } from '../hosting_error.js';
import { formatNegotiationErrors, type NegotiationResult } from '../plan/negotiate.js';
import type { CapabilityId } from '../plan/types.js';

/** How strictly a front door enforces the capability check. */
export type NegotiationMode = 'strict' | 'warn' | 'off';

const MODES: ReadonlySet<NegotiationMode> = new Set<NegotiationMode>(['strict', 'warn', 'off']);

/**
 * Resolve and validate a `negotiation` value.
 * @throws HostingError('InvalidPropsError') for an unknown mode.
 */
export function resolveNegotiationMode(mode: NegotiationMode | undefined, service: string): NegotiationMode {
  const resolved = mode ?? 'strict';
  if (!MODES.has(resolved)) {
    throw new HostingError('InvalidPropsError', {
      message: `Unknown negotiation mode '${String(resolved)}' on front door '${service}'.`,
      resolution: "Use 'strict' (default), 'warn', or 'off'.",
    });
  }
  return resolved;
}

/** Options for {@link settleUnmetCapabilities}. */
export type SettleOptions = {
  /** The resolved mode (`'off'` callers should not settle at all). */
  mode: Exclude<NegotiationMode, 'off'>;
  /** Capabilities the app waives — deploy without them, with a warning. */
  degrade?: CapabilityId[];
  /** Error code thrown in `strict` mode (each door keeps its historical code). */
  errorCode: string;
  /** Actionable resolution text for the `strict` error. */
  resolution: string;
};

/**
 * Apply the policy to a list of demanded-but-undelivered capabilities: waived
 * ones warn; the rest throw (`strict`) or warn (`warn`).
 *
 * @returns the {@link NegotiationResult} that was applied.
 * @throws HostingError(`opts.errorCode`) in `strict` mode when any unmet
 *   capability is not listed in `degrade`.
 */
export function settleUnmetCapabilities(
  service: string,
  unmet: readonly CapabilityId[],
  opts: SettleOptions,
): NegotiationResult {
  const waived = new Set(opts.degrade ?? []);
  const result: NegotiationResult = { errors: [], warnings: [] };
  for (const capability of unmet) {
    if (waived.has(capability)) result.warnings.push({ capability });
    else result.errors.push({ capability, tier: 'unsupported' });
  }

  if (result.errors.length > 0) {
    if (opts.mode === 'strict') {
      throw new HostingError(opts.errorCode, {
        message: formatNegotiationErrors(service, result),
        resolution: opts.resolution,
      });
    }
    process.stderr.write(
      `⚠️  ${formatNegotiationErrors(service, result)}\n   Proceeding anyway (\`negotiation: 'warn'\`).\n`,
    );
  }
  for (const w of result.warnings) {
    process.stderr.write(
      `⚠️  Hosting(${service}): capability '${w.capability}' is not available — deploying without it (waived via \`degrade\`).\n`,
    );
  }
  return result;
}
