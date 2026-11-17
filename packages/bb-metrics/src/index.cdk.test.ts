// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { test } from 'node:test';
import { Metrics } from './index.cdk.js';

// The documented `new Metrics(scope, id, { metrics: Metrics.fromExisting(...) })`
// runs during synth, so the cdk entry needs the real helper, not a guard.
test('CDK Metrics.fromExisting returns a reference usable during synth', () => {
	assert.deepStrictEqual(Metrics.fromExisting('MyOrg/SharedMetrics'), {
		__brand: 'ExternalMetricsRef',
		namespace: 'MyOrg/SharedMetrics',
	});
});
