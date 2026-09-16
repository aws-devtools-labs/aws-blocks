// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ComputeCapabilities } from '@aws-blocks/core';
import type { RetentionDays } from 'aws-cdk-lib/aws-logs';

/**
 * Options for the generic {@link Compute} block. These are service-agnostic
 * capability attributes ({@link ComputeCapabilities}) that describe *what* the
 * workload needs; Blocks selects the backing AWS service (Lambda or Fargate)
 * from them. A modest request/response workload stays on Lambda; a long-lived,
 * long-running, or high-memory workload is placed on a container.
 */
export interface ComputeProps extends ComputeCapabilities {
	/**
	 * CloudWatch Logs retention for this compute's log group. Logs are always
	 * captured; this only bounds how long they're kept. Per-compute override of
	 * the stack-wide `defaults.logRetention`.
	 */
	logRetention?: RetentionDays;
}
