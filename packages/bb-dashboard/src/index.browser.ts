// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser stub for Dashboard BB.
 * Dashboard is a CDK-only construct with no browser-side behavior.
 * Exported for pattern consistency with other BBs.
 */
export const DashboardErrors = {
	InvalidMetricConfig: 'InvalidMetricConfigException',
} as const;

export type {
	DashboardOptions,
	MetricConfig,
	MetricsBBRef,
	MetricsSource,
	LoggerBBRef,
	TracerBBRef,
} from './types.js';

export class Dashboard {
	readonly url: null = null;
	readonly dashboardName: string = '';
	constructor(..._args: unknown[]) {}
}
