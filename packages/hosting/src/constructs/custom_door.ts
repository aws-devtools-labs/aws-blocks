/**
 * BYO custom front door — the framework-enforced check-then-build seam.
 *
 * A custom door is a customer-authored {@link FrontDoorHooks} definition (see
 * `door_hooks.ts`). The framework drives it: before anything is built, every
 * capability the app DEMANDS must have its hook; after the build, what `route`
 * and the hooks REPORTED must cover the demand. An unmet demand (not waived via
 * `degrade`) fails HERE, at synth — never as a silently broken runtime. This is
 * "safe by construction": the guarantee holds even if the door author never
 * checks anything themselves, because the framework runs the check around them.
 * A platform that validates its door its own way can relax this on purpose via
 * `frontDoor.negotiation` (`'warn'` reports unmet demands; `'off'` skips the check).
 *
 * The door builds itself and returns a {@link LayerHandle} (the public `url` +
 * an `originHandle` a parent layer could attach to). We do NOT provision the
 * door — its hooks do; Hosting still owns the app (S3 assets, compute, backend),
 * handed over via `ctx` and `plan.backend`.
 */
import type { Construct } from 'constructs';
import type { AdapterContext, CapabilityId, CapabilityPlan } from '../plan/types.js';
import { type FrontDoorHooks, runFrontDoor } from './door_hooks.js';
import type { LayerHandle } from './layer.js';
import type { NegotiationMode } from './negotiation_policy.js';

/** Options for {@link renderCustomDoor}. */
export type RenderCustomDoorOptions = {
	/** Capabilities the app waives — deploy without them (else they fail in `strict`). */
	degrade?: CapabilityId[];
	/** How strictly the capability check is enforced. @default 'strict' */
	negotiation?: NegotiationMode;
};

/**
 * Check `door`'s hooks against `plan`, then build the custom door.
 *
 * @param scope the construct scope the door provisions its resources under.
 * @param plan  the service-agnostic {@link CapabilityPlan} for the deploy.
 * @param door  the customer's {@link FrontDoorHooks} definition.
 * @param ctx   the render context (the same CDK handles the built-in doors get).
 * @param opts.degrade capabilities the app waives — deploy without them (else they fail).
 * @param opts.negotiation `'strict'` (default) · `'warn'` · `'off'` — see {@link NegotiationMode}.
 * @throws HostingError('UnsupportedFrontDoorError') in `strict` mode when a demanded
 *   capability has no hook / isn't reported, and is not listed in `degrade`.
 */
export function renderCustomDoor<TDoor, TCtx extends AdapterContext>(
	scope: Construct,
	plan: CapabilityPlan,
	door: FrontDoorHooks<TDoor, TCtx>,
	ctx: TCtx,
	opts: RenderCustomDoorOptions = {},
): LayerHandle {
	return runFrontDoor(scope, plan, door, ctx, {
		degrade: opts.degrade,
		negotiation: opts.negotiation,
		errorCode: 'UnsupportedFrontDoorError',
		resolution:
			"Add the missing hook to your door (or report the capability from `route`), waive it via `frontDoor.degrade`, relax the check via `frontDoor.negotiation`, or choose a built-in door.",
	}).handle;
}

/**
 * The render context a custom door's hooks receive: the app infrastructure
 * Hosting already built (the same handles the built-in doors get).
 */
export type CustomDoorContext = AdapterContext & {
	/** The private assets bucket; static assets live under `builds/<buildId>/`. */
	bucket: import('aws-cdk-lib/aws-s3').IBucket;
	/** Compute functions by manifest name (SSR server, image optimization), if any. */
	computeFunctions?: Map<string, import('aws-cdk-lib/aws-lambda').IFunction>;
	/** Name of the SSR/server compute in `computeFunctions` (e.g. `default` / `server`). */
	serverComputeName?: string;
	/** Name of the image-optimization compute in `computeFunctions`. */
	imageComputeName?: string;
	/** Capabilities the app waived via `frontDoor.degrade`. */
	degrade?: CapabilityId[];
};
