// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { test } from 'node:test';
import { Metrics } from '@aws-blocks/bb-metrics';

// Run under --conditions=cdk (see package.json) to exercise the real CDK entry.
// Declaration parity checks method presence; these tests check behavior.
test('CDK Metrics runtime methods throw actionable synth errors', () => {
	// Call the prototype so testing the guard does not require provisioning a stack.
	const calls = {
		emit: () => Metrics.prototype.emit('Count', 1),
		emitBatch: () => Metrics.prototype.emitBatch([]),
		flush: () => Metrics.prototype.flush(),
	};

	for (const [method, call] of Object.entries(calls)) {
		assert.throws(call, {
			name: 'Error',
			message: new RegExp(`Metrics\\.${method}\\(\\) cannot be called during CDK synth\\.`),
		});
	}
});

test('CDK Metrics.fromExisting returns a reference usable during synth', () => {
	assert.deepStrictEqual(Metrics.fromExisting('MyOrg/SharedMetrics'), {
		__brand: 'ExternalMetricsRef',
		namespace: 'MyOrg/SharedMetrics',
	});
});
