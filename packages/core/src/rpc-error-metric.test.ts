// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A failed RPC call reaches the client as a JSON-RPC error envelope in an HTTP
 * 200 response, so Lambda's `Errors` metric never counts it. These tests drive
 * the real Lambda handler and check that each failed call writes exactly one
 * EMF line for the `AWSBlocks` / `RpcErrors` metric, and a successful call none.
 */
import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ApiError } from './errors.js';
import { createLambdaHandler } from './lambda-handler.js';
import { clearRouteRegistry } from './raw-route.js';
import { rpcErrorMetricLine, statusClass } from './rpc-error-metric.js';

type EmfLine = Record<string, unknown> & { _aws: { CloudWatchMetrics: Array<{ Namespace: string; Dimensions: string[][]; Metrics: Array<{ Name: string }> }> } };

const backend = {
	api: () => ({
		async ok() {
			return { fine: true };
		},
		async forbidden() {
			throw new ApiError('nope', 403, { name: 'Forbidden' });
		},
		async crash() {
			throw new Error('database is down');
		},
	}),
};

function rpcEvent(method: string) {
	return {
		httpMethod: 'POST',
		path: '/aws-blocks/api',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', method, params: [], id: 1 }),
		isBase64Encoded: false,
	};
}

describe('RpcErrors metric (Lambda)', () => {
	const savedFunction = process.env.AWS_LAMBDA_FUNCTION_NAME;
	const savedLog = console.log;
	const savedError = console.error;
	let lines: string[];

	beforeEach(() => {
		clearRouteRegistry();
		lines = [];
		process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-app-fn';
		console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
		console.error = () => {};
	});
	afterEach(() => {
		console.log = savedLog;
		console.error = savedError;
		if (savedFunction === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
		else process.env.AWS_LAMBDA_FUNCTION_NAME = savedFunction;
	});

	const emfLines = (): EmfLine[] =>
		lines.flatMap((l) => {
			try {
				const parsed = JSON.parse(l);
				return parsed?._aws?.CloudWatchMetrics ? [parsed as EmfLine] : [];
			} catch {
				return [];
			}
		});

	async function call(method: string) {
		const handler = createLambdaHandler(async () => backend);
		return (await handler(rpcEvent(method))) as { statusCode: number; body: string };
	}

	it('a successful call writes no metric', async () => {
		const res = await call('api.ok');
		assert.strictEqual(res.statusCode, 200);
		assert.deepStrictEqual(emfLines(), []);
	});

	it('a method that throws writes one 5xx RpcErrors line, though the response is HTTP 200', async () => {
		const res = await call('api.crash');
		assert.strictEqual(res.statusCode, 200, 'the RPC error envelope is an HTTP 200');
		assert.ok(JSON.parse(res.body).error, 'the body is a JSON-RPC error');
		const emf = emfLines();
		assert.strictEqual(emf.length, 1);
		const [line] = emf;
		const [directive] = line._aws.CloudWatchMetrics;
		assert.strictEqual(directive.Namespace, 'AWSBlocks');
		assert.deepStrictEqual(directive.Dimensions, [['FunctionName', 'StatusClass']]);
		assert.deepStrictEqual(directive.Metrics.map((m) => m.Name), ['RpcErrors']);
		assert.strictEqual(line.RpcErrors, 1);
		assert.strictEqual(line.FunctionName, 'my-app-fn');
		assert.strictEqual(line.StatusClass, '5xx');
		assert.strictEqual(line.Status, 500);
		assert.strictEqual(line.ApiNamespace, 'api');
		assert.strictEqual(line.Method, 'crash');
	});

	it('an ApiError with a 4xx status counts as 4xx', async () => {
		await call('api.forbidden');
		const [line] = emfLines();
		assert.strictEqual(line.StatusClass, '4xx');
		assert.strictEqual(line.Status, 403);
	});

	it('an unknown method counts as a 404', async () => {
		await call('api.missing');
		const [line] = emfLines();
		assert.strictEqual(line.StatusClass, '4xx');
		assert.strictEqual(line.Status, 404);
		assert.strictEqual(line.Method, 'missing');
	});

	it('writes nothing outside Lambda', async () => {
		delete process.env.AWS_LAMBDA_FUNCTION_NAME;
		await call('api.crash');
		assert.deepStrictEqual(emfLines(), []);
	});

	it('the error message is never written to the metric line', async () => {
		await call('api.crash');
		assert.ok(!lines.some((l) => l.includes('database is down') && l.includes('_aws')));
	});
});

describe('rpcErrorMetricLine', () => {
	it('classifies statuses', () => {
		assert.strictEqual(statusClass(400), '4xx');
		assert.strictEqual(statusClass(499), '4xx');
		assert.strictEqual(statusClass(500), '5xx');
		assert.strictEqual(statusClass(504), '5xx');
	});

	it('omits namespace and method when the request named none', () => {
		const line = JSON.parse(rpcErrorMetricLine({ status: 504 }, 'fn', 123));
		assert.strictEqual(line._aws.Timestamp, 123);
		assert.strictEqual('ApiNamespace' in line, false);
		assert.strictEqual('Method' in line, false);
	});
});
