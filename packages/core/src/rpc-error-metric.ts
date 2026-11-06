// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A CloudWatch metric for failed RPC calls on Lambda.
 *
 * An RPC failure reaches the client as a JSON-RPC error envelope in an HTTP 200
 * response, and the Lambda invocation itself succeeds, so Lambda's `Errors`
 * metric (and any alarm on it) never counts it. Each failed call therefore
 * writes one line in CloudWatch embedded metric format (EMF): Lambda's log
 * pipeline turns it into the `AWSBlocks` / `RpcErrors` metric with no SDK call
 * and no extra IAM permission.
 *
 * Dimensions are kept to `FunctionName` and `StatusClass` (`4xx` or `5xx`), so a
 * function adds at most two metrics. The API namespace, method and exact status
 * are written as plain properties, searchable with CloudWatch Logs Insights.
 *
 * @module
 */

/** CloudWatch namespace of the RPC error metric. */
export const RPC_ERROR_METRIC_NAMESPACE = 'AWSBlocks';

/** Name of the RPC error metric. */
export const RPC_ERROR_METRIC_NAME = 'RpcErrors';

/** What the dispatcher knows about a failed RPC call. */
export interface RpcErrorInfo {
	/** HTTP status of the error the client receives (in the JSON-RPC envelope). */
	status: number;
	/** The API namespace called, when the request named one. */
	namespace?: string;
	/** The method called, when the request named one. */
	method?: string;
}

/**
 * Longest API namespace or method name written to the metric line. On an
 * unknown namespace or method both come straight from the request body, so a
 * cap keeps one call from writing a line too big for a single CloudWatch Logs
 * event (which would no longer parse as EMF). Real names are short identifiers.
 */
export const RPC_ERROR_METRIC_MAX_NAME_LENGTH = 128;

/** Marker appended to a name cut at {@link RPC_ERROR_METRIC_MAX_NAME_LENGTH}. */
const TRUNCATED_MARKER = '…[truncated]';

function capName(name: string): string {
	return name.length > RPC_ERROR_METRIC_MAX_NAME_LENGTH
		? name.slice(0, RPC_ERROR_METRIC_MAX_NAME_LENGTH) + TRUNCATED_MARKER
		: name;
}

/** `4xx` for a client error, `5xx` for everything else. */
export function statusClass(status: number): '4xx' | '5xx' {
	return status >= 400 && status < 500 ? '4xx' : '5xx';
}

/** The EMF log line for one failed RPC call. */
export function rpcErrorMetricLine(info: RpcErrorInfo, functionName: string, timestamp: number = Date.now()): string {
	return JSON.stringify({
		_aws: {
			Timestamp: timestamp,
			CloudWatchMetrics: [
				{
					Namespace: RPC_ERROR_METRIC_NAMESPACE,
					Dimensions: [['FunctionName', 'StatusClass']],
					Metrics: [{ Name: RPC_ERROR_METRIC_NAME, Unit: 'Count' }],
				},
			],
		},
		FunctionName: functionName,
		StatusClass: statusClass(info.status),
		Status: info.status,
		...(info.namespace ? { ApiNamespace: capName(info.namespace) } : {}),
		...(info.method ? { Method: capName(info.method) } : {}),
		[RPC_ERROR_METRIC_NAME]: 1,
	});
}

/**
 * Write the RPC error metric for one failed call, on Lambda only (the EMF line
 * is extracted from the function's log stream). Never throws: a metric must not
 * change the response.
 *
 * Writes to `process.stdout` directly, like `bb-metrics`, rather than through
 * `console.log`: with Lambda's JSON log format the runtime wraps `console`
 * output in its own JSON object, so `_aws` would no longer be top-level and
 * nothing would be extracted.
 */
export function emitRpcErrorMetric(info: RpcErrorInfo, env: NodeJS.ProcessEnv = process.env): void {
	const functionName = env.AWS_LAMBDA_FUNCTION_NAME;
	if (!functionName) return;
	try {
		process.stdout.write(`${rpcErrorMetricLine(info, functionName)}\n`);
	} catch {
		// A metric is best-effort.
	}
}
