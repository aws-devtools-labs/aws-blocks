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
import type { ComputeType, ScopeParent } from '@aws-blocks/core';
import type { ComputeBase, ComputeProvider } from '@aws-blocks/core/cdk/internal';
import { BuildingBlockScope } from '@aws-blocks/core/cdk';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import { ContainerCompute } from '@aws-blocks/bb-container-compute/cdk';
import type { ComputeProps } from './types.js';

export type { ComputeProps } from './types.js';

/**
 * A compute defined by an explicit `type`. `Compute` is a Building Block that
 * **owns** the concrete backing compute (`LambdaCompute` for `serverless`,
 * `ContainerCompute` for `container`) and exposes it via {@link resolve}, so it
 * satisfies {@link ComputeProvider} — a workload given a `Compute` resolves to
 * the real, branded backing the framework wires against. The customer reaches
 * for `Compute`; the backing types are internal.
 *
 * The type parameter `K` is inferred from `props.type`, so
 * `new Compute(scope, id, { type: 'container', … })` is a
 * `ComputeProvider<'container'>` and `{ type: 'serverless', … }` is a
 * `ComputeProvider<'serverless'>`. That kind flows into a workload's options:
 * `AsyncJob` exposes `maxConcurrencyPerCPU` only for a container compute, so
 * passing it with a serverless compute is a compile error (not a silent no-op).
 *
 * Composition (not inheritance): `Compute` is its own `BuildingBlockScope` node
 * and the backing is a child it constructs. Only the backing registers as a
 * compute, so the compute census and finalize steps see exactly one compute per
 * `Compute`.
 */
export class Compute<K extends ComputeType = ComputeType> extends BuildingBlockScope implements ComputeProvider<K> {
	readonly #backing: ComputeBase;

	constructor(scope: ScopeParent, id: string, props: ComputeProps & { type: K }) {
		super(id, { parent: scope, vpc: {} });
		const { logRetention } = props;
		// Narrow against the plain discriminated union: the `& { type: K }` on the
		// public signature (which carries the kind for compute-conditional options)
		// defeats TS's discrimination on `props.type`, so re-bind to `ComputeProps`
		// to recover per-arm field narrowing below.
		const p: ComputeProps = props;
		this.#backing =
			p.type === 'container'
				? new ContainerCompute(this, 'backing', {
						size: p.size,
						scaling: p.scaling,
						image: p.image,
						logRetention,
					})
				: new LambdaCompute(this, 'backing', {
						memory: p.memory,
						maxTimeoutSeconds: p.maxTimeoutSeconds,
						logRetention,
					});
	}

	/**
	 * Resolve to the concrete backing compute this block owns — the value a
	 * workload wires against. Satisfies {@link ComputeProvider}, interchangeable
	 * with a raw backing (which resolves to itself). The result's `type` is
	 * narrowed to this block's kind `K`.
	 */
	resolve(): ComputeBase & { readonly type: K } {
		return this.#backing as ComputeBase & { readonly type: K };
	}
}
