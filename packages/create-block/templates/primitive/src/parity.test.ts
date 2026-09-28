// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Ensures the four entry points expose a consistent public error surface. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __BB_CLASS__Errors as MockErrors } from './index.mock.js';
import { __BB_CLASS__Errors as AwsErrors } from './index.aws.js';
import { __BB_CLASS__Errors as CdkErrors } from './index.cdk.js';
import { __BB_CLASS__Errors as BrowserErrors } from './index.browser.js';

test('error constants are identical across mock / aws / cdk / browser', () => {
	assert.deepEqual(MockErrors, AwsErrors);
	assert.deepEqual(MockErrors, CdkErrors);
	assert.deepEqual(MockErrors, BrowserErrors);
});
