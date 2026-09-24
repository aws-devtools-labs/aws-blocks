// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The generic **`Compute`** Building Block — the one compute surface customers
 * use. The customer states the compute `type` explicitly and configures it with
 * that type's options; Blocks maps the type to the AWS service that backs it. The
 * service name never appears in the API.
 *
 * @example
 * ```ts
 * const api    = new Compute(scope, 'api', { type: 'serverless', memory: 512 });
 * const worker = new Compute(scope, 'worker', { type: 'container', size: { vcpu: 1, memory: 2048 } });
 *
 * const jobs = new AsyncJob(scope, 'jobs', { compute: worker, handler });
 * ```
 */
import type { ComputeHandle, ScopeParent } from '@aws-blocks/core';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import { ContainerCompute } from '@aws-blocks/bb-container-compute/cdk';
import type { ComputeProps } from './types.js';

export type { ComputeProps } from './types.js';

/**
 * A compute defined by an explicit `type`. Constructing one returns the concrete,
 * `Scope`-backed backing compute (`LambdaCompute` for `serverless`,
 * `ContainerCompute` for `container`) — the value a customer holds and hands to
 * `{ compute }` is the real, branded compute the framework recognizes. `Compute`
 * is therefore a thin selector on `type`, not a wrapper.
 *
 * The static return type is {@link ComputeHandle} (the opaque public handle) so
 * customer code treats it as "a compute" without depending on the backing class.
 */
export class Compute {
	constructor(scope: ScopeParent, id: string, props: ComputeProps) {
		const { logRetention } = props;
		// A JS constructor may return an object, which becomes the result of `new`.
		// Return the concrete Scope-backed compute so the customer holds the real,
		// branded instance the framework's delivery + finalize logic recognizes.
		if (props.type === 'container') {
			// biome-ignore lint/correctness/noConstructorReturn: intentional selector — see class docs.
			return new ContainerCompute(scope, id, {
				size: props.size,
				scaling: props.scaling,
				image: props.image,
				logRetention,
			}) as unknown as Compute;
		}
		// biome-ignore lint/correctness/noConstructorReturn: intentional selector — see class docs.
		return new LambdaCompute(scope, id, {
			memory: props.memory,
			maxTimeoutSeconds: props.maxTimeoutSeconds,
			logRetention,
		}) as unknown as Compute;
	}
}

/**
 * The type of a constructed {@link Compute} as customers hold it — an opaque
 * {@link ComputeHandle}. The runtime value is the concrete backing compute.
 */
export type ComputeInstance = ComputeHandle;
