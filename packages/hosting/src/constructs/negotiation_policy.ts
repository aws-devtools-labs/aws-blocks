/**
 * Negotiation policy — how strictly a front door enforces the capability check.
 *
 * Every door negotiates the deploy's {@link CapabilityPlan} against its own
 * `supports()` declaration. By default (`'strict'`) a capability the app DEMANDS
 * that the door can't serve fails synth — never a silent production break. A
 * platform that owns and validates its door its own way can relax that on
 * purpose with the `negotiation` option on the `frontDoor` prop:
 *
 *   - `'strict'` (default) — unmet demands throw at synth (today's behavior).
 *   - `'warn'`   — unmet demands are reported as synth warnings; the deploy proceeds.
 *   - `'off'`    — the check is skipped entirely; the door owns correctness.
 *
 * `degrade` (per-capability acceptance) is unchanged and applies in every mode.
 * One helper for every door keeps the three modes behaving identically.
 */
import { HostingError } from '../hosting_error.js';
import { formatNegotiationErrors, negotiate } from '../plan/negotiate.js';
import type { CapabilityId, CapabilityPlan, FrontDoorAdapter } from '../plan/types.js';

/** How strictly a front door enforces the capability check. See {@link enforceNegotiation}. */
export type NegotiationMode = 'strict' | 'warn' | 'off';

const MODES: ReadonlySet<NegotiationMode> = new Set<NegotiationMode>(['strict', 'warn', 'off']);

/** Options for {@link enforceNegotiation}. */
export type EnforceNegotiationOptions = {
	/** Capabilities the app waives — deploy without them (else they fail in `strict`). */
	degrade?: CapabilityId[];
	/** How strictly to enforce. @default 'strict' */
	negotiation?: NegotiationMode;
	/** Error code thrown in `strict` mode (each door keeps its historical code). */
	errorCode: string;
	/** Actionable resolution text for the `strict` error. */
	resolution: string;
};

/**
 * Negotiate `plan` against `door` and apply the negotiation policy: throw
 * (`strict`), report (`warn`), or skip (`off`). Accepted degradations are always
 * reported as warnings.
 *
 * @throws HostingError(`opts.errorCode`) in `strict` mode when a demanded
 *   capability is unsupported and not listed in `degrade`.
 * @throws HostingError('InvalidPropsError') for an unknown `negotiation` value.
 */
export function enforceNegotiation(
	plan: CapabilityPlan,
	door: Pick<FrontDoorAdapter, 'service' | 'supports'>,
	opts: EnforceNegotiationOptions,
): void {
	const mode = opts.negotiation ?? 'strict';
	if (!MODES.has(mode)) {
		throw new HostingError('InvalidPropsError', {
			message: `Unknown negotiation mode '${String(mode)}' on front door '${door.service}'.`,
			resolution: "Use 'strict' (default), 'warn', or 'off'.",
		});
	}

	if (mode === 'off') {
		process.stderr.write(
			`⚠️  Hosting(${door.service}): capability check disabled (\`negotiation: 'off'\`) — the door owns correctness.\n`,
		);
		return;
	}

	const result = negotiate(plan, door, { degrade: opts.degrade });

	if (result.errors.length > 0) {
		if (mode === 'strict') {
			throw new HostingError(opts.errorCode, {
				message: formatNegotiationErrors(door.service, result),
				resolution: opts.resolution,
			});
		}
		// 'warn': report every unmet demand, then proceed.
		process.stderr.write(
			`⚠️  ${formatNegotiationErrors(door.service, result)}\n` +
				`   Proceeding anyway (\`negotiation: 'warn'\`).\n`,
		);
	}

	for (const w of result.warnings) {
		process.stderr.write(
			`⚠️  Hosting(${door.service}): capability '${w.capability}' is not available — deploying without it (waived via \`degrade\`).\n`,
		);
	}
}
