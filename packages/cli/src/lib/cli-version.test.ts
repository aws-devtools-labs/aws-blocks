// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

import { cliVersion } from './cli-version.js';

describe('cliVersion', () => {
	it('returns the CLI package.json version (not 0.0.0)', () => {
		const require = createRequire(import.meta.url);
		// dist/lib/cli-version.test.js → ../../package.json
		const pkg = require('../../package.json') as { version?: string };

		const version = cliVersion();

		assert.strictEqual(
			version,
			pkg.version,
			'cliVersion must resolve the CLI package.json version',
		);
		assert.notStrictEqual(version, '0.0.0', 'should not fall back to 0.0.0');
		assert.match(version, /^\d+\.\d+\.\d+/, 'should look like a semver');
	});
});
