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
	 * Function memory (MB). Defaults to the framework's standard handler memory
	 * (2048 MB). CPU scales with memory on Lambda; there is no separate vCPU knob.
	 *
	 * The default is deliberately generous because the single shared handler
	 * serves BOTH the synchronous API path (fronted by API Gateway, which caps a
	 * request at 29s) AND async workers (SQS/AsyncJob, up to the 900s function
	 * timeout) — so it is sized for the heavier async path. An app whose compute
	 * only handles short request/response traffic can right-size cost by setting a
	 * lower `memory` here (e.g. 512–1024 MB).
	 */
	memory?: number;

	/**
	 * The function's max runtime ceiling, in seconds (Lambda's function timeout,
	 * 1–900). Defaults to the platform maximum (900s). A job's own `timeoutSeconds`
	 * must fit under this ceiling.
	 *
	 * This is the ASYNC ceiling: it bounds SQS/AsyncJob invocations, which can run
	 * for minutes. It does NOT extend the synchronous API path — API Gateway cuts
	 * a REST request off at 29s regardless of this value — so lowering it to
	 * "right-size the API handler" would instead shorten the async budget. Leave it
	 * at the default unless you are intentionally capping async work.
	 */
	maxTimeoutSeconds?: number;

	/**
	 * The instruction-set architecture for the compute's Lambda function.
	 * Defaults to **`Architecture.ARM_64`** (AWS Graviton), which is ~20% cheaper
	 * per GB-second than x86_64 at equivalent performance.
	 */
	architecture?: Architecture;
}
