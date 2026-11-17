// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS-runtime entry point for `ContainerCompute`.
 *
 * At runtime a compute is inert — it *is* the environment the handler already
 * runs in, and its infrastructure was created at synth. So the runtime
 * `ContainerCompute` constructs (so the import succeeds and any `{ compute }`
 * reference resolves) but provisions nothing and pulls in no CDK. `setEnv` is a
 * no-op — configuration is injected at synth.
 */
import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import type { ContainerComputeProps } from './types.js';

export type { ContainerComputeProps } from './types.js';

export class ContainerCompute extends Scope {
	constructor(scope: ScopeParent, id: string, _options?: ContainerComputeProps) {
		super(id, { parent: scope });
	}

	setEnv(_key: string, _value: string): void {}
}
