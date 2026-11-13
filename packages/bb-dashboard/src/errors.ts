// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed error constants for Dashboard. Use with `isBlocksError()` in catch blocks.
 *
 * Metric configs are validated when the dashboard body is built, which happens
 * in the stack finalizer (`finalizeDashboards`) after the backend module has
 * loaded — not in the `Dashboard` constructor. A `try`/`catch` around
 * `new Dashboard(...)` therefore never sees the error: in an app it rejects
 * stack creation (`BlocksStack.create()` / `BlocksBackend.create()`) and so
 * fails CDK synthesis; in a CDK unit test that builds the stack directly, it is
 * thrown by `finalizeDashboards(stack)`.
 *
 * @example
 * ```typescript
 * import { isBlocksError } from '@aws-blocks/core';
 * import { finalizeDashboards } from '@aws-blocks/core/cdk';
 * import { Dashboard, DashboardErrors } from '@aws-blocks/bb-dashboard';
 *
 * new Dashboard(stack, 'dash', {
 *   metrics: { metrics, metricConfigs: [{ name: '', stat: 'Sum' }] }, // empty name triggers validation
 * });
 *
 * try {
 *   finalizeDashboards(stack);
 * } catch (e) {
 *   if (isBlocksError(e, DashboardErrors.InvalidMetricConfig)) {
 *     console.error('Metric name cannot be empty');
 *   }
 * }
 * ```
 */
export const DashboardErrors = {
	InvalidMetricConfig: 'InvalidMetricConfigException',
} as const;
