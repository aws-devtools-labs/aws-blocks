// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The requirements vocabulary and the one implementation behind
 * `ComputeProvider.provide()`, kept in a single module on purpose: a compute is
 * declared by *what a workload needs*, and the translation of those needs into a
 * concrete compute lives right next to the shape that expresses them. Adding a
 * requirement means touching one file, and core needs neither half — it never
 * validates requirements and never hands them to a compute.
 *
 * Both conditional entries (`index.ts` and `index.cdk.ts`) delegate to
 * {@link provideCompute}, so parent resolution, requirements validation and the
 * requirements-to-Lambda mapping exist exactly once. The entries differ only in
 * the type they promise, which is the one thing they cannot share: this repo
 * sets no TypeScript `customConditions`, so `tsc` resolves
 * `@aws-blocks/bb-lambda-compute` to the mock (CDK-free) types in every file —
 * including `index.cdk.ts`.
 *
 * That single-JS/two-declarations split is what makes this work at all. The
 * emitted JavaScript is shared, and `@aws-blocks/bb-lambda-compute` is imported
 * as a bare specifier, so the loader picks the right `LambdaCompute` per
 * condition: the provisioning one under `cdk`, the inert handle in the deployed
 * runtime, in local dev and in the browser.
 *
 * Deliberately free of `aws-cdk-lib`. Passing the timeout as a plain number of
 * seconds (`LambdaComputeProps.timeout` takes `Duration | number`) is what keeps
 * it that way, so this module is safe to load from the runtime entry and no CDK
 * reaches a Lambda bundle or a browser.
 */

import { LambdaCompute } from '@aws-blocks/bb-lambda-compute';
import type { ScopeParent } from '@aws-blocks/core';

/**
 * What a workload needs from its compute, stated as requirements rather than as
 * a service choice.
 *
 * A customer says what the workload needs and the framework resolves that to a
 * concrete compute (via `ComputeProvider.provide()`). Concrete compute classes
 * (`LambdaCompute`, later container/Kubernetes ones) stay internal, so the
 * public surface never names an AWS service and a workload can be re-fulfilled on
 * a different compute without the app changing.
 *
 * Phase 1 has exactly one fulfillment — serverless — so requirements configure
 * it and are validated against its limits by {@link validateComputeRequirements}.
 * There is deliberately **no** `computeType` selector and **no** container
 * `image` option: a one-value enum would imply a choice that does not exist, and
 * nothing could fulfil an image yet. Both arrive with the container fulfillment
 * that makes them real.
 *
 * Every field is optional — omitting all of them asks for the framework's
 * defaults, which is what an app that never mentions compute gets today.
 */
export interface ComputeRequirements {
	/**
	 * How long a single invocation may run before the platform stops it, in
	 * seconds.
	 *
	 * Raise this for slow work (a long report, a large migration); lower it to
	 * fail fast and bound cost. Must fit the resolved compute's ceiling — see
	 * {@link SERVERLESS_COMPUTE_LIMITS}.
	 */
	timeoutSeconds?: number;

	/**
	 * Memory available to the workload, in MiB.
	 *
	 * On serverless this also scales CPU proportionally, so it is the dial for
	 * "make this faster" as well as "give this more room". Must fit the resolved
	 * compute's range — see {@link SERVERLESS_COMPUTE_LIMITS}.
	 */
	memoryMb?: number;
}

/**
 * The limits of the serverless fulfillment — the only compute Phase 1 can
 * resolve requirements to.
 *
 * Stated here rather than inside the compute package so the requirements surface
 * can reject an impossible request before any concrete compute is constructed,
 * and so the error text is identical wherever the check runs.
 */
export const SERVERLESS_COMPUTE_LIMITS = {
	minTimeoutSeconds: 1,
	maxTimeoutSeconds: 900,
	minMemoryMb: 128,
	maxMemoryMb: 10240,
} as const;

/** Whether `value` is a positive integer (requirements are whole units). */
function isPositiveInteger(value: number): boolean {
	return Number.isInteger(value) && value > 0;
}

/**
 * Validate requirements against the serverless fulfillment, throwing with an
 * actionable message when the workload cannot be satisfied.
 *
 * Phase 1 fails rather than degrades: there is no compute-type escape hatch yet,
 * so a workload needing more than serverless allows has nowhere to go, and
 * silently clamping it would produce an app that deploys and then times out
 * under load. The error names the offending field, the requested value, and the
 * ceiling, because "invalid compute requirements" alone would leave a customer
 * guessing which dial to turn.
 *
 * The check is pure and runs in every environment (not just at synth), so a bad
 * value fails the first time the app runs locally rather than only at `cdk synth`.
 *
 * @param requirements - The requirements to check.
 * @param context - Identifies the compute in the message (its scoped id), so an
 *   app with several computes points at the right one.
 * @throws If a requirement is not a positive integer or exceeds a serverless limit.
 */
export function validateComputeRequirements(requirements: ComputeRequirements, context?: string): void {
	const where = context ? ` for "${context}"` : '';
	const { timeoutSeconds, memoryMb } = requirements;
	const limits = SERVERLESS_COMPUTE_LIMITS;

	if (timeoutSeconds !== undefined) {
		if (!isPositiveInteger(timeoutSeconds)) {
			throw new Error(
				`Invalid compute requirement${where}: timeoutSeconds must be a positive whole number of ` +
					`seconds, got ${timeoutSeconds}.`,
			);
		}
		// Subsumed by the positive-integer check while `minTimeoutSeconds` is 1 (an
		// integer that passed that check is already >= 1), so this cannot fire today.
		// Kept coupled to the limit so raising the floor makes it enforce, matching the
		// reachable `memoryMb` floor below rather than leaving the two fields asymmetric.
		if (timeoutSeconds < limits.minTimeoutSeconds) {
			throw new Error(
				`Compute requirement${where} cannot be met: timeoutSeconds is ${timeoutSeconds}, but the ` +
					`minimum is ${limits.minTimeoutSeconds}.`,
			);
		}
		if (timeoutSeconds > limits.maxTimeoutSeconds) {
			throw new Error(
				`Compute requirement${where} cannot be met: timeoutSeconds is ${timeoutSeconds}, but the ` +
					`maximum is ${limits.maxTimeoutSeconds} (15 minutes). Split the work into smaller units, ` +
					`or move it to a background job that is not bound by a single invocation.`,
			);
		}
	}

	if (memoryMb !== undefined) {
		if (!isPositiveInteger(memoryMb)) {
			throw new Error(
				`Invalid compute requirement${where}: memoryMb must be a positive whole number of MiB, ` +
					`got ${memoryMb}.`,
			);
		}
		if (memoryMb < limits.minMemoryMb) {
			throw new Error(
				`Compute requirement${where} cannot be met: memoryMb is ${memoryMb}, but the minimum is ` +
					`${limits.minMemoryMb}.`,
			);
		}
		if (memoryMb > limits.maxMemoryMb) {
			throw new Error(
				`Compute requirement${where} cannot be met: memoryMb is ${memoryMb}, but the maximum is ` +
					`${limits.maxMemoryMb} (10 GiB).`,
			);
		}
	}
}

/**
 * Provision a compute satisfying `requirements`, parented to `scope`.
 *
 * Returns the condition-resolved `LambdaCompute` as `unknown`: the caller is the
 * conditional entry, and it is the only place that knows whether that value is a
 * CDK `Compute` or the runtime `Scope` handle.
 *
 * @param id - Identifies the compute; every resource it owns derives its name from this.
 * @param requirements - What the workload needs. Validated here, so the same bad
 *   value fails the same way in local dev and at synth.
 * @param scope - Where to attach. Defaults to the ambient `BlocksStack`.
 */
export function provideCompute(id: string, requirements?: ComputeRequirements, scope?: ScopeParent): unknown {
	// Validated in every condition, not just at synth: the check is pure, and a
	// requirement no compute can host should be rejected the first time the app
	// runs rather than only once it reaches `cdk synth`.
	validateComputeRequirements(requirements ?? {}, id);
	// Resolve the parent: an explicit `scope`, else the ambient BlocksStack the
	// stack's constructor sets before it imports the backend module. At synth the
	// ambient is present; at runtime and in local dev there is no stack and no
	// ambient — the runtime/mock `Scope` tolerates an undefined parent (it falls
	// back to a stub), so the declaration resolves to an inert handle rather than
	// throwing. The `cdk` entry adds the "declared before the stack existed" guard,
	// because only under CDK does a missing parent mean a real mistake: a Construct
	// cannot be attached to nothing.
	const parent = scope ?? (globalThis as { CURRENT_BLOCKS_STACK?: ScopeParent }).CURRENT_BLOCKS_STACK;
	// The provider owns the translation: requirements are the customer's
	// vocabulary, and each fulfillment takes its own platform's settings. Keeping
	// the mapping here is what lets a compute package stay unaware that
	// requirements exist — and lets a second fulfillment map them differently.
	// `parent` may be undefined at runtime/local dev (no ambient stack); the mock
	// `Scope` resolves that to a root stub. Under CDK the entry's guard has already
	// ensured a real parent, so the cast never hides a missing-scope bug there.
	// Pass the requirements straight through: both props are optional and the
	// fulfillment applies its own default when a value is undefined, so an omitted
	// requirement takes the compute's default. A future requirement is one more line
	// here, not another conditional spread.
	return new LambdaCompute(parent as ScopeParent, id, {
		timeout: requirements?.timeoutSeconds,
		memorySize: requirements?.memoryMb,
	});
}
