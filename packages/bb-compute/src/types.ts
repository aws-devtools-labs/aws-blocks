// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ComputeOptions } from '@aws-blocks/core';
import type { RetentionDays } from 'aws-cdk-lib/aws-logs';

/**
 * Options for the generic {@link Compute} block: the discriminated
 * {@link ComputeOptions} (a required `type` plus that type's own options) with an
 * optional per-compute log-retention override.
 */
export type ComputeProps = ComputeOptions & {
	/**
	 * CloudWatch Logs retention for this compute's log group. Logs are always
	 * captured; this only bounds how long they're kept. Per-compute override of
	 * the stack-wide `defaults.logRetention`.
	 */
	logRetention?: RetentionDays;
};
