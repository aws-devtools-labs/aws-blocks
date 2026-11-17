// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Observability for a Lambda-backed compute: X-Ray tracing activation plus the
 * CloudWatch Dashboard widget builders (health, logs, traces).
 *
 * `LambdaCompute` keeps its class body thin by delegating here:
 * - `applyTracing()` → {@link applyXRayTracing}
 * - `dashboardSection(region)` → the `build*Widgets` functions, which let the
 *   Dashboard Building Block assemble a per-compute section without knowing the
 *   compute is Lambda-shaped.
 */
import { Duration } from 'aws-cdk-lib';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import { ConcreteWidget, GraphWidget, LogQueryWidget, Metric } from 'aws-cdk-lib/aws-cloudwatch';
import type { CfnFunction, IFunction } from 'aws-cdk-lib/aws-lambda';

// ── Tracing (X-Ray) ───────────────────────────────────────────────────────

/**
 * Flip a Lambda compute's function to X-Ray `Active` tracing mode. Called from
 * `LambdaCompute.applyTracing()` (which the framework invokes on every compute
 * when the app contains a `Tracer`).
 *
 * This is per-function only — it does **not** grant IAM. The permission to
 * publish trace segments is granted once on the shared execution role by core's
 * `finalizeTracing`, rather than once per compute (they all assume the same
 * role). X-Ray Active mode traces the function on **every** invocation path —
 * API Gateway requests, SQS-driven async jobs, EventBridge-scheduled runs alike.
 *
 * @param fn - The Lambda function backing the compute.
 */
export function applyXRayTracing(fn: IFunction): void {
	(fn.node.defaultChild as CfnFunction).tracingConfig = { mode: 'Active' };
}

// ── Health widgets ──────────────────────────────────────────────────────────

/**
 * Build Lambda health widgets: Invocations, Errors, Duration, ConcurrentExecutions.
 * Returns two rows of two 12-wide GraphWidgets each.
 *
 * @param functionName - The Lambda function name the widgets query metrics for.
 * @param region - AWS region the widgets query metrics in.
 */
export function buildHealthWidgets(functionName: string, region: string): IWidget[][] {
	const invocations = new GraphWidget({
		title: 'Lambda Invocations',
		width: 12,
		height: 6,
		region,
		left: [
			new Metric({
				namespace: 'AWS/Lambda',
				metricName: 'Invocations',
				dimensionsMap: { FunctionName: functionName },
				statistic: 'Sum',
				period: Duration.seconds(60),
			}),
		],
	});

	const errors = new GraphWidget({
		title: 'Lambda Errors',
		width: 12,
		height: 6,
		region,
		left: [
			new Metric({
				namespace: 'AWS/Lambda',
				metricName: 'Errors',
				dimensionsMap: { FunctionName: functionName },
				statistic: 'Sum',
				period: Duration.seconds(60),
			}),
		],
	});

	const duration = new GraphWidget({
		title: 'Lambda Duration',
		width: 12,
		height: 6,
		region,
		left: [
			new Metric({
				namespace: 'AWS/Lambda',
				metricName: 'Duration',
				dimensionsMap: { FunctionName: functionName },
				statistic: 'Average',
				period: Duration.seconds(60),
				label: 'Average',
			}),
			new Metric({
				namespace: 'AWS/Lambda',
				metricName: 'Duration',
				dimensionsMap: { FunctionName: functionName },
				statistic: 'p99',
				period: Duration.seconds(60),
				label: 'p99',
			}),
		],
	});

	const concurrency = new GraphWidget({
		title: 'Lambda Concurrent Executions',
		width: 12,
		height: 6,
		region,
		left: [
			new Metric({
				namespace: 'AWS/Lambda',
				metricName: 'ConcurrentExecutions',
				dimensionsMap: { FunctionName: functionName },
				statistic: 'Maximum',
				period: Duration.seconds(60),
			}),
		],
	});

	return [
		[invocations, errors],
		[duration, concurrency],
	];
}

// ── Log widgets ─────────────────────────────────────────────────────────────

/**
 * Build log widgets for a Lambda log group: a Log Insights recent-errors query
 * plus a log-volume graph. Returns one widget per row (each 24 wide).
 *
 * @param logGroupName - The CloudWatch log group name (e.g. `/aws/lambda/<fn>`).
 * @param region - AWS region the widgets query in.
 */
export function buildLoggingWidgets(logGroupName: string, region: string): IWidget[][] {
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

// ── Trace widget (no L2 construct exists) ────────────────────────────────────

export interface TraceWidgetProps {
	title?: string;
	functionName: string;
	region: string;
	width?: number;
	height?: number;
}

/**
 * Custom widget that renders an X-Ray trace list in the CloudWatch Dashboard.
 *
 * CloudWatch supports a `"type": "trace"` widget, but CDK provides no L2
 * construct for it, so this extends `ConcreteWidget` to emit the correct JSON.
 */
export class TraceWidget extends ConcreteWidget {
	private readonly props: TraceWidgetProps;

	constructor(props: TraceWidgetProps) {
		super(props.width ?? 24, props.height ?? 9);
		this.props = props;
	}

	toJson(): any[] {
		return [
			{
				type: 'trace',
				width: this.width,
				height: this.height,
				x: this.x ?? 0,
				y: this.y ?? 0,
				properties: {
					title: this.props.title ?? 'Traces',
					region: this.props.region,
					filters: {
						query: `service(id(name: "${this.props.functionName}", type: "AWS::Lambda::Function"))`,
						group: 'Default',
					},
				},
			},
		];
	}
}

/**
 * Build the X-Ray trace widget for a Lambda function. Returns a single row.
 *
 * @param functionName - The Lambda function name the trace list filters to.
 * @param region - AWS region the widget queries in.
 */
export function buildTracingWidgets(functionName: string, region: string): IWidget[][] {
	return [[new TraceWidget({ title: 'Traces', functionName, region, width: 24, height: 9 })]];
}
