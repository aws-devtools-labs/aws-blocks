// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub — a compute is server-side infrastructure and never runs in the
// browser. The backend module that constructs it is type-imported by frontends,
// so this stub keeps CDK out of the browser bundle while the reference resolves.
export class LambdaCompute {
	setEnv(_key: string, _value: string): void {}
}
export type { LambdaComputeProps } from './types.js';
