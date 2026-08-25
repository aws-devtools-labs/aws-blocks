// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Architecture } from 'aws-cdk-lib/aws-lambda';

/**
 * Options for constructing a `LambdaCompute`.
 */
export interface LambdaComputeProps {
	/**
	 * The instruction-set architecture for the compute's Lambda function.
	 * Defaults to **`Architecture.ARM_64`** (AWS Graviton), which is ~20% cheaper
	 * per GB-second than x86_64 at equivalent performance.
	 *
	 * @internal Not yet reachable by customers. `LambdaCompute` is internal and
	 * the umbrella constructs the default compute with no options, so today this
	 * only takes effect through the arm64 default. A customer-facing override
	 * (e.g. for a backend that bundles an x86-only native addon) will be exposed
	 * alongside the public compute-configuration surface, not through this
	 * internal class directly.
	 */
	architecture?: Architecture;
}
