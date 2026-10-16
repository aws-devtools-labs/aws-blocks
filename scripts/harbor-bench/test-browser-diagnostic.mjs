// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBrowserFailure } from './task/tests/browser-diagnostic.mjs';

test('browser failures produce fixed reasons, never app-supplied text', () => {
	assert.equal(classifyBrowserFailure({ name: 'TimeoutError', message: 'SECRET' }), 'control_timeout');
	assert.equal(classifyBrowserFailure({ code: 'ERR_ASSERTION', actual: 'SECRET' }), 'value_mismatch');
	assert.equal(classifyBrowserFailure(new Error('locator.check: Clicking the checkbox did not change its state')), 'checkbox_state_unchanged');
	assert.equal(classifyBrowserFailure(new Error('Element is not attached to the DOM SECRET')), 'element_detached');
	assert.equal(classifyBrowserFailure(new Error('strict mode violation SECRET')), 'ambiguous_control');
	assert.equal(classifyBrowserFailure(new Error('SECRET')), 'runtime_error');
	assert.equal(classifyBrowserFailure(null), 'runtime_error');
});
