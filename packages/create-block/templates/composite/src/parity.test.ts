// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Ensures the default and browser entry points expose a consistent surface. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __BB_CLASS__Errors as MainErrors } from './index.js';
import { __BB_CLASS__Errors as BrowserErrors } from './index.browser.js';

test('error constants are identical across default / browser', () => {
	assert.deepEqual(MainErrors, BrowserErrors);
});
