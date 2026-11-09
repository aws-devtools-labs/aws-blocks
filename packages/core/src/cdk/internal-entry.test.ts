// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The framework-internal CDK seams are on `@aws-blocks/core/cdk/internal` and
 * NOT on the public `@aws-blocks/core/cdk` barrel (which `@aws-blocks/blocks`
 * re-exports to customers). `check:api` reports only the aws-runtime entry, so
 * this test is what keeps them off the public CDK surface.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import * as publicCdk from '../index.cdk.js';
import * as internal from './internal.js';

/** Runtime values that must stay internal (types are checked by `tsc` at their import sites). */
const INTERNAL_ONLY = [
	'BASELINE_FORMAT_VERSION',
	'baselineDir',
	'claimBaseline',
	'hasOrphanedBaselines',
	'readBaselineFormatVersion',
	'registerSharedConfig',
	'deployTimeLambdaCode',
	'deployTimeLambdaEntry',
] as const;

describe('@aws-blocks/core/cdk/internal', () => {
	test('exports the baseline protocol and the deploy-time Lambda helpers', () => {
		for (const name of INTERNAL_ONLY) {
			assert.ok(name in internal, `${name} is exported from ./cdk/internal`);
		}
		assert.strictEqual(internal.BASELINE_FORMAT_VERSION, 1);
		assert.strictEqual(typeof internal.deployTimeLambdaEntry, 'function');
	});

	test('the public @aws-blocks/core/cdk entry does not export them', () => {
		for (const name of INTERNAL_ONLY) {
			assert.ok(!(name in publicCdk), `${name} must not be on the public ./cdk entry`);
		}
	});

	test('the helpers take options objects', () => {
		assert.strictEqual(
			internal.baselineDir({ backendHandlerPath: '/app/aws-blocks/index.handler.ts', stack: 'Prod' }),
			'/app/aws-blocks/baselines/Prod',
		);
		assert.throws(
			() => internal.deployTimeLambdaEntry({ moduleUrl: import.meta.url, source: './no-such-handler' }),
			/deploy-time Lambda handler of @aws-blocks\/core is missing/,
		);
	});
});
