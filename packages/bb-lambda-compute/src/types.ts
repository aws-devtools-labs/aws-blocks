// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Architecture } from 'aws-cdk-lib/aws-lambda';

/**
 * Options for constructing a `LambdaCompute`.
 */
export interface LambdaComputeProps {
	/**
	 * The instruction-set architecture for the compute's Lambda function.
	 * Defaults to **`Architecture.ARM_64`** (AWS Graviton): arm64 Lambda is ~20%
	 * cheaper per GB-second than x86_64 at the same performance, and the Blocks
	 * backend is a pure-JavaScript esbuild bundle with no architecture-specific
	 * native dependencies, so the switch is free.
	 *
	 * Override to `Architecture.X86_64` if you bundle an x86-only native addon
	 * into your backend:
	 *
	 * ```ts
	 * import { Architecture } from 'aws-cdk-lib/aws-lambda';
	 * new LambdaCompute(scope, 'compute', { architecture: Architecture.X86_64 });
	 * ```
	 */
	architecture?: Architecture;
}
