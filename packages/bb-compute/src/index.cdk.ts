// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The generic **`Compute`** Building Block — the one compute surface customers
 * use. Rather than naming an AWS service, a customer describes the workload's
 * capabilities (timeout, memory, cpu, whether it's long-lived, an optional
 * image) and Blocks picks the backing service: a short, request/response
 * workload runs on Lambda; anything that exceeds Lambda's envelope runs on a
 * container (Fargate). This keeps the public API a statement of *needs*, not of
 * infrastructure — Blocks knows which AWS service satisfies them.
 *
 * @example
 * ```ts
 * // Stays on Lambda — nothing exceeds its envelope.
 * const api = new Compute(scope, 'api', { memory: 512 });
 *
 * // Runs on a container — a 30-minute budget is beyond Lambda's 15-minute cap.
 * const worker = new Compute(scope, 'worker', { timeoutSeconds: 1800, memory: 2048 });
 *
 * // Assign a block's handler to it.
 * const jobs = new AsyncJob(scope, 'jobs', { compute: worker, handler });
 * ```
 */
import type { ComputeHandle, ScopeParent } from '@aws-blocks/core';
import { selectComputeKind } from '@aws-blocks/core';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import { ContainerCompute } from '@aws-blocks/bb-container-compute/cdk';
import type { ComputeProps } from './types.js';

export type { ComputeProps } from './types.js';

/**
 * A compute defined by capability, not by service. Constructing one resolves —
 * from its {@link ComputeProps} — to the concrete backing compute
 * (`LambdaCompute` or `ContainerCompute`) and **returns that instance**: the
 * value a customer holds and hands to `{ compute }` is the real, branded compute
 * the framework's delivery logic recognizes. `Compute` is therefore a selector,
 * not a wrapper — there is no extra construct layer or forwarding to maintain.
 *
 * The static return type is {@link ComputeHandle} (the opaque public handle) so
 * customer code treats it as "a compute" without depending on which service
 * backs it; internally the returned object is the concrete compute.
 */
export class Compute {
	constructor(scope: ScopeParent, id: string, props: ComputeProps = {}) {
		const { logRetention, ...capabilities } = props;
		const kind = selectComputeKind(capabilities);
		// A JS constructor may return an object, which becomes the result of `new`.
		// We return the concrete compute so the customer holds the real, branded
		// instance (LambdaCompute / ContainerCompute) — the one AsyncJob and the
		// finalize steps recognize — with no wrapper indirection.
		if (kind === 'container') {
			// biome-ignore lint/correctness/noConstructorReturn: intentional selector — see class docs.
			return new ContainerCompute(scope, id, { capabilities, logRetention }) as unknown as Compute;
		}
		// biome-ignore lint/correctness/noConstructorReturn: intentional selector — see class docs.
		return new LambdaCompute(scope, id, { logRetention }) as unknown as Compute;
	}
}

/**
 * The type of a constructed {@link Compute} as customers should hold it — an
 * opaque {@link ComputeHandle}. Declared as a companion type so
 * `const c: ComputeInstance = new Compute(...)` reads cleanly; the runtime value
 * is the concrete backing compute.
 */
export type ComputeInstance = ComputeHandle;
