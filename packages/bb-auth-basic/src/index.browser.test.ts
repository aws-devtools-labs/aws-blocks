// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AuthBasicErrors } from './index.browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('AuthBasic browser entry', () => {
	test('exports browser-safe error constants without importing the server entry', () => {
		assert.strictEqual(AuthBasicErrors.InvalidCredentials, 'InvalidCredentialsException');

		const browserEntry = readFileSync(join(__dirname, 'index.browser.js'), 'utf8');
		assert.ok(!browserEntry.includes("from './index.js'"), browserEntry);
		assert.ok(!browserEntry.includes('from "./index.js"'), browserEntry);
	});
});
