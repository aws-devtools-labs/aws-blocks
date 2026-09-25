/**
 * Conformance test kit for a custom {@link FrontDoorLayerAdapter}.
 *
 * `supports()` is self-declared and TRUSTED by the negotiator — the framework
 * can't verify at synth that a door actually builds what it claims, so an
 * over-declaring door would pass synth and break at runtime. This kit closes
 * that gap in the AUTHOR'S OWN tests (it is NOT a synth-time gate): call it from
 * a `node:test` (or any runner) and it throws with an actionable message if the
 * adapter is internally inconsistent.
 *
 * It checks three things:
 *   1. `supports()` is TOTAL — returns a valid {@link SupportTier} for every
 *      {@link CapabilityId} (no throw, no bogus value). A door that forgets a
 *      capability is caught here, not at a customer's synth.
 *   2. The adapter can serve the given `plan` — negotiation against its own
 *      declaration produces no errors (it doesn't demand-fail the plan it's
 *      handed). Defaults to a static-only baseline every door must serve; pass a
 *      richer `plan` (SSR, backend, …) to assert the capabilities your door adds.
 *   3. `renderLayer` runs without throwing on that plan and returns a well-formed
 *      {@link LayerHandle}: a non-empty `originHandle.domainName`, a valid
 *      `protocol`, and a public `url` on the (root) layer.
 *
 * @throws Error (not tied to any test runner) on the first failed check.
 */
import { App, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { CAPABILITY_DEMAND, formatNegotiationErrors, negotiate } from '../plan/negotiate.js';
import type { AdapterContext, CapabilityId, CapabilityPlan, SupportTier } from '../plan/types.js';
import type { FrontDoorLayerAdapter } from './layer.js';

const VALID_TIERS: ReadonlySet<SupportTier> = new Set<SupportTier>(['core', 'extended', 'degraded', 'unsupported']);

/** Every capability in the vocabulary (the demand registry is the source of truth). */
const ALL_CAPABILITIES = Object.keys(CAPABILITY_DEMAND) as CapabilityId[];

/** The baseline plan every front door must serve: route + static assets, nothing else. */
const STATIC_BASELINE: CapabilityPlan = {
	origins: [{ id: 'blocks-s3', kind: 'static' }],
	routes: { entries: [{ pattern: '/*', kind: 'static' }], redirects: [], headers: [] },
	policies: { spaFallback: true, hasServer: false, skewEnabled: false },
	release: { buildId: 'conformance' },
};

/** Options for {@link assertAdapterConformance}. */
export type AdapterConformanceOptions = {
	/** Scope to render under (a throwaway App/Stack is created when omitted). */
	scope?: Construct;
	/** Plan to exercise — defaults to a static-only baseline. Pass a richer one to cover more. */
	plan?: CapabilityPlan;
	/** Render context the adapter reads (bucket, compute, …). Defaults to `{}`. */
	ctx?: AdapterContext;
	/** Capabilities accepted in degraded form for the negotiation check. */
	degrade?: CapabilityId[];
};

/**
 * Assert a custom {@link FrontDoorLayerAdapter} is internally consistent. Throws
 * on the first failure; returns normally when the adapter conforms.
 */
export function assertAdapterConformance(
	adapter: FrontDoorLayerAdapter,
	options: AdapterConformanceOptions = {},
): void {
	const label = `Adapter '${adapter.service ?? '(missing service id)'}'`;
	if (!adapter.service || typeof adapter.service !== 'string') {
		throw new Error(`${label}: \`service\` must be a non-empty string (it is the negotiator/diagnostics id).`);
	}

	// 1. supports() is total over the capability vocabulary.
	for (const capability of ALL_CAPABILITIES) {
		let tier: SupportTier;
		try {
			tier = adapter.supports(capability);
		} catch (err) {
			throw new Error(
				`${label}: supports('${capability}') threw — it must return a SupportTier for every capability. (${err})`,
			);
		}
		if (!VALID_TIERS.has(tier)) {
			throw new Error(
				`${label}: supports('${capability}') returned ${JSON.stringify(tier)} — expected 'core' | 'extended' | 'degraded' | 'unsupported'.`,
			);
		}
	}

	const plan = options.plan ?? STATIC_BASELINE;

	// 2. The adapter can serve the plan it is handed (declaration ↔ demand).
	const result = negotiate(plan, adapter, { degrade: options.degrade });
	if (result.errors.length > 0) {
		throw new Error(
			`${label}: does not serve the conformance plan.\n${formatNegotiationErrors(adapter.service, result)}`,
		);
	}

	// 3. renderLayer builds without throwing and returns a well-formed handle.
	const scope =
		options.scope ??
		new Stack(new App(), 'AdapterConformanceStack', { env: { account: '111111111111', region: 'us-east-1' } });
	let handle: ReturnType<FrontDoorLayerAdapter['renderLayer']>;
	try {
		handle = adapter.renderLayer(scope, plan, options.ctx ?? {});
	} catch (err) {
		throw new Error(
			`${label}: renderLayer threw on the conformance plan — it must build the door for a plan it declares it supports. (${err})`,
		);
	}
	if (!handle || typeof handle !== 'object') {
		throw new Error(`${label}: renderLayer must return a LayerHandle.`);
	}
	const originHandle = handle.originHandle;
	if (!originHandle || typeof originHandle.domainName !== 'string' || originHandle.domainName.length === 0) {
		throw new Error(
			`${label}: renderLayer must return an \`originHandle\` with a non-empty \`domainName\` (the attach point for nesting).`,
		);
	}
	if (originHandle.protocol !== 'http' && originHandle.protocol !== 'https') {
		throw new Error(
			`${label}: \`originHandle.protocol\` must be 'http' or 'https' (got ${JSON.stringify(originHandle.protocol)}).`,
		);
	}
	if (typeof handle.url !== 'string' || handle.url.length === 0) {
		throw new Error(
			`${label}: renderLayer must set a public \`url\` on the root layer (the deploy's public address).`,
		);
	}
}
