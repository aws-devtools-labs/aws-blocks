// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CloudWatch Dashboard widget builders for a container-backed compute — the
 * ECS/Fargate analogues of the Lambda widgets in `bb-lambda-compute`. Kept in a
 * separate module so `ContainerCompute` stays a thin class body that delegates
 * (`healthWidgets` → CPU/Memory/TaskCount, `loggingWidgets` → the log group).
 */
import { Duration } from 'aws-cdk-lib';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import { GraphWidget, LogQueryWidget, Metric } from 'aws-cdk-lib/aws-cloudwatch';

/**
 * Build Fargate health widgets: CPU utilization, memory utilization, and running
 * task count. Returns two rows.
 *
 * @param serviceName - The ECS service name the widgets query metrics for.
 * @param clusterName - The ECS cluster name (a required dimension for ECS metrics).
 * @param region - AWS region the widgets query in.
 */
export function buildContainerHealthWidgets(serviceName: string, clusterName: string, region: string): IWidget[][] {
	const dims = { ServiceName: serviceName, ClusterName: clusterName };

	const cpu = new GraphWidget({
		title: 'Container CPU Utilization',
		width: 12,
		height: 6,
		region,
		left: [
			new Metric({
				namespace: 'AWS/ECS',
				metricName: 'CPUUtilization',
				dimensionsMap: dims,
				statistic: 'Average',
				period: Duration.seconds(60),
			}),
		],
	});

	const memory = new GraphWidget({
		title: 'Container Memory Utilization',
		width: 12,
		height: 6,
		region,
		left: [
			new Metric({
				namespace: 'AWS/ECS',
				metricName: 'MemoryUtilization',
				dimensionsMap: dims,
				statistic: 'Average',
				period: Duration.seconds(60),
			}),
		],
	});

	const tasks = new GraphWidget({
		title: 'Running Tasks',
		width: 24,
		height: 6,
		region,
		left: [
			new Metric({
				namespace: 'ECS/ContainerInsights',
				metricName: 'RunningTaskCount',
				dimensionsMap: dims,
				statistic: 'Average',
				period: Duration.seconds(60),
			}),
		],
	});

	return [[cpu, memory], [tasks]];
}

/**
 * Build log widgets for a container's log group: a recent-errors Log Insights
 * query plus a log-volume graph. Returns one widget per row.
 *
 * @param logGroupName - The CloudWatch log group name the awslogs driver writes to.
 * @param region - AWS region the widgets query in.
 */
export function buildContainerLoggingWidgets(logGroupName: string, region: string): IWidget[][] {
	const logQuery = new LogQueryWidget({
		title: 'Recent Errors',
		width: 24,
		height: 6,
		region,
		logGroupNames: [logGroupName],
		queryLines: [
			'fields @timestamp, @message',
			'filter @message like /ERROR/ or level = "error"',
			'sort @timestamp desc',
			'limit 20',
		],
	});

	const logVolume = new GraphWidget({
		title: 'Log Volume',
		width: 24,
		height: 6,
		region,
		left: [
			new Metric({
				namespace: 'AWS/Logs',
				metricName: 'IncomingLogEvents',
				dimensionsMap: { LogGroupName: logGroupName },
				statistic: 'Sum',
				period: Duration.seconds(300),
			}),
		],
	});

	return [[logQuery], [logVolume]];
}

/**
 * Build the trace widget row for a container compute. Container tracing (ADOT)
 * is a later task; this renders the service-scoped trace list so the section is
 * present once tracing is wired.
 *
 * @param serviceName - The ECS service name the trace filter scopes to.
 * @param region - AWS region the widget queries in.
 */
export function buildContainerTracingWidgets(serviceName: string, region: string): IWidget[][] {
	const traces = new LogQueryWidget({
		title: `Traces — ${serviceName}`,
		width: 24,
		height: 6,
		region,
		logGroupNames: [],
		queryLines: ['fields @timestamp, @message', 'limit 20'],
	});
	return [[traces]];
}
