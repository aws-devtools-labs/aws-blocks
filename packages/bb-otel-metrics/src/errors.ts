// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed error constants for OTel Metrics. Use with `isBlocksError()` in catch blocks.
 *
 * @example
 * ```typescript
 * import { isBlocksError } from '@aws-blocks/core';
 * import { OtelMetricsErrors } from '@aws-blocks/bb-otel-metrics';
 *
 * try {
 *   metrics.emit('', 1);
 * } catch (e) {
 *   if (isBlocksError(e, OtelMetricsErrors.InvalidMetricName)) {
 *     // handle invalid metric name
 *   }
 * }
 * ```
 */
export const OtelMetricsErrors = {
	/** Metric name is empty or exceeds 255 characters (OTel instrument-name limit). */
	InvalidMetricName: 'InvalidMetricNameException',
} as const;
