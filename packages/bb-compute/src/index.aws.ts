// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS-runtime entry for the generic `Compute` block. At runtime a compute is
 * inert (its infrastructure was created at synth), so this selects and returns
 * the inert concrete handle — matching the CDK selector's return-an-instance
 * shape so a `{ compute }` reference resolves identically in both phases.
 */
import type { ScopeParent } from '@aws-blocks/core';
import { selectComputeKind } from '@aws-blocks/core';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute';
import { ContainerCompute } from '@aws-blocks/bb-container-compute';
import type { ComputeProps } from './types.js';

export type { ComputeProps } from './types.js';

export class Compute {
	constructor(scope: ScopeParent, id: string, props: ComputeProps = {}) {
		const { logRetention, ...capabilities } = props;
		if (selectComputeKind(capabilities) === 'container') {
			// biome-ignore lint/correctness/noConstructorReturn: intentional selector.
			return new ContainerCompute(scope, id, { capabilities, logRetention }) as unknown as Compute;
		}
		// biome-ignore lint/correctness/noConstructorReturn: intentional selector.
		return new LambdaCompute(scope, id, { logRetention }) as unknown as Compute;
	}
}
