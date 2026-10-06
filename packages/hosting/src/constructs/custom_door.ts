/**
 * BYO custom front door — the framework-enforced negotiate-then-render seam.
 *
 * A custom door is a customer-authored {@link FrontDoorLayerAdapter}. Before we
 * let it build anything, we negotiate the deploy's {@link CapabilityPlan}
 * against the adapter's own `supports()` declaration: a capability the app
 * DEMANDS that the door marks `unsupported` (without an explicit
 * `degrade` opt-in) fails HERE, at synth — never as a silently broken runtime.
 * This is "safe by construction": the guarantee holds even if the adapter author
 * never calls `negotiate` themselves, because the framework runs it around them.
 * A platform that validates its door its own way can relax this on purpose via
 * `frontDoor.negotiation` (`'warn'` reports unmet demands; `'off'` skips the check).
 *
 * On success the adapter renders its own door and returns a {@link LayerHandle}
 * (the public `url` + an `originHandle` a parent layer could attach to). We do
 * NOT provision the door — the adapter does; Hosting still owns the app (S3
 * assets, compute, backend), handed over via `ctx` and `plan.backend`.
 */
import type { Construct } from 'constructs';
import type { AdapterContext, CapabilityId, CapabilityPlan } from '../plan/types.js';
import type { FrontDoorLayerAdapter, LayerHandle } from './layer.js';
import { enforceNegotiation, type NegotiationMode } from './negotiation_policy.js';

/** Options for {@link renderCustomDoor}. */
export type RenderCustomDoorOptions = {
	/** Capabilities the app waives — deploy without them (else they fail in `strict`). */
	degrade?: CapabilityId[];
	/** How strictly the capability check is enforced. @default 'strict' */
	negotiation?: NegotiationMode;
};

/**
 * Negotiate `plan` against `adapter`, then render the custom door.
 *
 * @param scope   the construct scope the adapter provisions its resources under.
 * @param plan    the service-agnostic {@link CapabilityPlan} for the deploy.
 * @param adapter the customer's {@link FrontDoorLayerAdapter}.
 * @param ctx     the render context (the same CDK handles the built-in doors get).
 * @param opts.degrade capabilities the app waives — deploy without them (else they fail).
 * @param opts.negotiation `'strict'` (default) · `'warn'` · `'off'` — see {@link NegotiationMode}.
 * @throws HostingError('UnsupportedFrontDoorError') in `strict` mode when a demanded
 *   capability is `unsupported` and not listed in `degrade`.
 */
export function renderCustomDoor(
	scope: Construct,
	plan: CapabilityPlan,
	adapter: FrontDoorLayerAdapter,
	ctx: AdapterContext,
	opts: RenderCustomDoorOptions = {},
): LayerHandle {
	enforceNegotiation(plan, adapter, {
		degrade: opts.degrade,
		negotiation: opts.negotiation,
		errorCode: 'UnsupportedFrontDoorError',
		resolution:
			"Support the missing capabilities in your adapter's `supports`/`renderLayer`, waive one via `frontDoor.degrade`, relax the check via `frontDoor.negotiation`, or choose a built-in door.",
	});
	return adapter.renderLayer(scope, plan, ctx);
}
