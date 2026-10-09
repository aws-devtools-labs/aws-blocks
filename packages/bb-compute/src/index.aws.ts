// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS-runtime entry for the generic `Compute` block. At runtime a compute is
 * inert (its infrastructure was created at synth), so this owns an inert backing
 * selected by the explicit `type` and exposes it via `compute` — matching the
 * CDK block's `ComputeProvider` shape so a `{ compute }` reference resolves in
 * every phase.
 */
import type { ComputeType, ScopeParent } from '@aws-blocks/core';
import { Scope } from '@aws-blocks/core';
import type { ComputeBase, ComputeProvider } from '@aws-blocks/core/cdk/internal';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute';
import { ContainerCompute } from '@aws-blocks/bb-container-compute';
import type { ComputeProps } from './types.js';

export type { ComputeProps } from './types.js';

export class Compute<K extends ComputeType = ComputeType> extends Scope implements ComputeProvider<K> {
	readonly #backing: Scope;

	constructor(scope: ScopeParent, id: string, props: ComputeProps & { type: K }) {
		super(id, { parent: scope });
		this.#backing =
			props.type === 'container'
				? new ContainerCompute(this, 'backing')
				: new LambdaCompute(this, 'backing');
	}

	resolve(): ComputeBase & { readonly type: K } {
		return this.#backing as unknown as ComputeBase & { readonly type: K };
	}
}
