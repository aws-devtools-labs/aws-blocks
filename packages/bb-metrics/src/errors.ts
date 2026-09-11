// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed error constants for Metrics. Use with `isBlocksError()` in catch blocks.
 *
 * @example
 * ```typescript
 * import { isBlocksError } from '@aws-blocks/core';
 * import { MetricsErrors } from '@aws-blocks/bb-metrics';
 *
 * try {
 *   metrics.emit('', 1);
 * } catch (e) {
 *   if (isBlocksError(e, MetricsErrors.InvalidMetricName)) {
 *     // handle invalid metric name
 *   }
 * }
 * ```
 */
export const MetricsErrors = {
	/** Metric name is empty or exceeds 1024 characters. */
	InvalidMetricName: 'InvalidMetricNameException',
	/** Metric value is non-finite or outside the CloudWatch-supported range. */
	InvalidMetricValue: 'InvalidMetricValueException',
	/** Metric timestamp is not a valid Date. */
	InvalidTimestamp: 'InvalidTimestampException',
	/** Dimensions exceed 30 entries, or contain empty keys/values, or key/value exceeds 1024 chars. */
	InvalidDimensions: 'InvalidDimensionsException',
	/** Batch contains more than 100 metrics. */
	BatchTooLarge: 'BatchTooLargeException',
	/** Namespace is empty, too long, contains invalid characters, or uses reserved AWS/ prefix. */
	InvalidNamespace: 'InvalidNamespaceException',
} as const;
