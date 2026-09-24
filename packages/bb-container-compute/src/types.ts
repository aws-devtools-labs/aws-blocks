// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ContainerScaling, ContainerSize } from '@aws-blocks/core';
import type { RetentionDays } from 'aws-cdk-lib/aws-logs';

/**
 * Options for constructing an internal `ContainerCompute`.
 *
 * A `ContainerCompute` is never instantiated directly by a customer — the public
 * `Compute` block builds one when the customer states `type: 'container'`. These
 * are the container's own options plus the per-compute log-retention knob.
 *
 * @internal
 */
export interface ContainerComputeProps {
	/** A valid vCPU + memory combination. Sizes the Fargate task. */
	size?: ContainerSize;
	/** Instance-count bounds and scaling strategy (Application Auto Scaling). */
	scaling?: ContainerScaling;
	/** Custom container image (an ECR image URI). Blocks builds one when omitted. */
	image?: string;
	/**
	 * CloudWatch Logs retention for this container's log group. Logs are always
	 * captured (the task's `awslogs` driver ships stdout/stderr here); this only
	 * bounds how long they're kept. Per-compute override of the stack-wide
	 * `defaults.logRetention` (used when omitted).
	 */
	logRetention?: RetentionDays;
}
