// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Architecture } from 'aws-cdk-lib/aws-lambda';
import type { RetentionDays } from 'aws-cdk-lib/aws-logs';

/**
 * Options for constructing a `LambdaCompute`.
 */
export interface LambdaComputeProps {
	/**
	 * CloudWatch Logs retention for this compute's handler log group. Logs are
	 * always captured; this only bounds how long they're kept. Per-compute
	 * override of the stack-wide `defaults.logRetention` (used when omitted).
	 */
	logRetention?: RetentionDays;

	/**
	 * The instruction-set architecture for the compute's Lambda function.
	 * Defaults to **`Architecture.ARM_64`** (AWS Graviton), which is ~20% cheaper
	 * per GB-second than x86_64 at equivalent performance.
	 *
	 * This is the interface customers will configure the compute through once it
	 * is public — set `Architecture.X86_64` here for a backend that bundles an
	 * x86-only native addon. It is not wired to a customer entry point yet
	 * (pre-launch the umbrella constructs the default compute with no options),
	 * so today it only takes effect through the arm64 default.
	 */
	architecture?: Architecture;
}
