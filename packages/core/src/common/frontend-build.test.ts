// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { frontendBuildReuse, REUSE_FRONTEND_BUILD_CONTEXT, SKIP_FRONTEND_BUILD_ENV } from './frontend-build.js';

describe('frontendBuildReuse', () => {
	it('builds as usual with neither the env var nor the context', () => {
		assert.strictEqual(frontendBuildReuse(undefined, {}), undefined);
	});

	it('a destroy synth (the context) reuses an existing build', () => {
		assert.strictEqual(frontendBuildReuse('true', {}), 'if-present');
		assert.strictEqual(frontendBuildReuse(true, {}), 'if-present');
		assert.strictEqual(frontendBuildReuse('false', {}), undefined);
	});

	it('the env var requires reusing the build, and wins over the context', () => {
		assert.strictEqual(frontendBuildReuse(undefined, { [SKIP_FRONTEND_BUILD_ENV]: '1' }), 'required');
		assert.strictEqual(frontendBuildReuse(undefined, { [SKIP_FRONTEND_BUILD_ENV]: 'true' }), 'required');
		assert.strictEqual(frontendBuildReuse('true', { [SKIP_FRONTEND_BUILD_ENV]: '1' }), 'required');
		assert.strictEqual(frontendBuildReuse(undefined, { [SKIP_FRONTEND_BUILD_ENV]: '0' }), undefined);
	});

	it('names the context key and env var the scripts and docs use', () => {
		assert.strictEqual(REUSE_FRONTEND_BUILD_CONTEXT, 'reuseFrontendBuild');
		assert.strictEqual(SKIP_FRONTEND_BUILD_ENV, 'BLOCKS_SKIP_FRONTEND_BUILD');
	});
});
