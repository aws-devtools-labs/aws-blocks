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
import type { ScopeParent } from '@aws-blocks/core';
import type { ComputeBase, ComputeProvider } from '@aws-blocks/core/cdk/internal';
import { BuildingBlockScope } from '@aws-blocks/core/cdk';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import { ContainerCompute } from '@aws-blocks/bb-container-compute/cdk';
import type { ComputeProps } from './types.js';

export type { ComputeProps } from './types.js';

/**
 * A compute defined by an explicit `type`. `Compute` is a Building Block that
 * **owns** the concrete backing compute (`LambdaCompute` for `serverless`,
 * `ContainerCompute` for `container`) and exposes it via {@link compute}, so it
 * satisfies {@link ComputeProvider} — a workload given a `Compute` resolves
 * `.compute` to the real, branded backing the framework wires against. The
 * customer reaches for `Compute`; the backing types are internal.
 *
 * Composition (not inheritance): `Compute` is its own `BuildingBlockScope` node
 * and the backing is a child it constructs. Only the backing registers as a
 * compute, so the compute census and finalize steps see exactly one compute per
 * `Compute`.
 */
export class Compute extends BuildingBlockScope implements ComputeProvider {
	readonly #backing: ComputeBase;

	constructor(scope: ScopeParent, id: string, props: ComputeProps) {
		super(id, { parent: scope, vpc: {} });
		const { logRetention } = props;
		this.#backing =
			props.type === 'container'
				? new ContainerCompute(this, 'backing', {
						size: props.size,
						scaling: props.scaling,
						image: props.image,
						logRetention,
					})
				: new LambdaCompute(this, 'backing', {
						memory: props.memory,
						maxTimeoutSeconds: props.maxTimeoutSeconds,
						logRetention,
					});
	}

	/**
	 * The concrete backing compute this block owns — the value a workload wires
	 * against. Satisfies {@link ComputeProvider}, interchangeable with a raw
	 * backing (which provides itself).
	 */
	get compute(): ComputeBase {
		return this.#backing;
	}
}
