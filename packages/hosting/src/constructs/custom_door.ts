/**
 * BYO custom front door — the framework-enforced negotiate-then-render seam.
 *
 * A custom door is a customer-authored {@link FrontDoorLayerAdapter}. Before we
 * let it build anything, we negotiate the deploy's {@link CapabilityPlan}
 * against the adapter's own `supports()` declaration: a capability the app
 * DEMANDS that the door marks `unsupported` (or `degraded` without an explicit
 * `degrade` opt-in) fails HERE, at synth — never as a silently broken runtime.
 * This is "safe by construction": the guarantee holds even if the adapter author
 * never calls `negotiate` themselves, because the framework runs it around them.
 *
 * On success the adapter renders its own door and returns a {@link LayerHandle}
 * (the public `url` + an `originHandle` a parent layer could attach to). We do
 * NOT provision the door — the adapter does; Hosting still owns the app (S3
 * assets, compute, backend), handed over via `ctx` and `plan.backend`.
 */
import type { Construct } from 'constructs';
import { HostingError } from '../hosting_error.js';
import { formatNegotiationErrors, negotiate } from '../plan/negotiate.js';
import type { AdapterContext, CapabilityId, CapabilityPlan } from '../plan/types.js';
import type { FrontDoorLayerAdapter, LayerHandle } from './layer.js';

/**
 * Negotiate `plan` against `adapter`, then render the custom door.
 *
 * @param scope   the construct scope the adapter provisions its resources under.
 * @param plan    the service-agnostic {@link CapabilityPlan} for the deploy.
 * @param adapter the customer's {@link FrontDoorLayerAdapter}.
 * @param ctx     the render context (the same CDK handles the built-in doors get).
 * @param degrade capabilities the app accepts in a degraded form (else they fail).
 * @throws HostingError('UnsupportedFrontDoorError') when a demanded capability is
 *   `unsupported`, or `degraded` without being listed in `degrade`.
 */
export function renderCustomDoor(
	scope: Construct,
	plan: CapabilityPlan,
	adapter: FrontDoorLayerAdapter,
	ctx: AdapterContext,
	degrade?: CapabilityId[],
): LayerHandle {
	const result = negotiate(plan, adapter, { degrade });
	if (result.errors.length > 0) {
		throw new HostingError('UnsupportedFrontDoorError', {
			message: formatNegotiationErrors(adapter.service, result),
			resolution:
				"Support the missing capabilities in your adapter's `supports`/`renderLayer`, accept a degraded one via `frontDoor.degrade`, or choose a built-in door.",
		});
	}
	return adapter.renderLayer(scope, plan, ctx);
}
