// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ComputeCapabilities } from '@aws-blocks/core';
import type { RetentionDays } from 'aws-cdk-lib/aws-logs';

/**
 * Options for constructing an internal `ContainerCompute`.
 *
 * A `ContainerCompute` is never instantiated directly by a customer — the public
 * `Compute` block builds one when a workload's {@link ComputeCapabilities}
 * exceed Lambda's envelope. These options are the capability values `Compute`
 * resolved, plus the same per-compute log-retention knob `LambdaCompute` takes.
 *
 * @internal
 */
export interface ContainerComputeProps {
	/**
	 * The capability attributes this container was selected for. `cpu`/`memory`
	 * size the Fargate task; `timeoutSeconds` is stamped into config so the
	 * runtime poller can enforce a per-handler wall-clock limit; `image`, when
	 * set, replaces the Blocks-built default image.
	 */
	capabilities?: ComputeCapabilities;

	/**
	 * CloudWatch Logs retention for this container's log group. Logs are always
	 * captured (the task's `awslogs` driver ships stdout/stderr here); this only
	 * bounds how long they're kept. Per-compute override of the stack-wide
	 * `defaults.logRetention` (used when omitted).
	 */
	logRetention?: RetentionDays;
}
