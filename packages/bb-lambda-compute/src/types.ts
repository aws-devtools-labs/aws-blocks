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
	 * Function memory (MB). Defaults to the framework's standard handler memory.
	 * CPU scales with memory on Lambda; there is no separate vCPU knob.
	 */
	memory?: number;

	/**
	 * The function's max runtime ceiling, in seconds (Lambda's function timeout,
	 * 1–900). Defaults to the platform maximum. A job's own `timeoutSeconds` must
	 * fit under this ceiling.
	 */
	maxTimeoutSeconds?: number;

	/**
	 * The instruction-set architecture for the compute's Lambda function.
	 * Defaults to **`Architecture.ARM_64`** (AWS Graviton), which is ~20% cheaper
	 * per GB-second than x86_64 at equivalent performance.
	 */
	architecture?: Architecture;
}
