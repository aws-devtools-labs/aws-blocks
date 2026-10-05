// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub — compute is server-side infrastructure and never runs in the
// browser. The backend module that constructs it is type-imported by frontends,
// so this stub keeps CDK out of the browser bundle while the reference resolves.
import type { ComputeBase, ComputeProvider } from '@aws-blocks/core/cdk/internal';

export class Compute implements ComputeProvider {
	setEnv(_key: string, _value: string): void {}
	get compute(): ComputeBase {
		return this as unknown as ComputeBase;
	}
}
export type { ComputeProps } from './types.js';
