// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { buildProfile, shouldSkipBuild, withBuildProfile } from './build_profile.js';

describe('shouldSkipBuild', () => {
	const present = () => true;
	const missing = () => false;

	it('builds by default', () => {
		assert.strictEqual(withBuildProfile({}, () => shouldSkipBuild(undefined, present)), false);
	});

	it("'if-present' reuses an existing build and builds when there is none", () => {
		assert.strictEqual(withBuildProfile({ reuseBuild: 'if-present' }, () => shouldSkipBuild(undefined, present)), true);
		assert.strictEqual(withBuildProfile({ reuseBuild: 'if-present' }, () => shouldSkipBuild(undefined, missing)), false);
	});

	it("'required' always skips, so a missing output surfaces as the adapter's own error", () => {
		assert.strictEqual(withBuildProfile({ reuseBuild: 'required' }, () => shouldSkipBuild(undefined, missing)), true);
	});

	it('an explicit skipBuild option wins over the profile', () => {
		assert.strictEqual(withBuildProfile({ reuseBuild: 'required' }, () => shouldSkipBuild(false, present)), false);
		assert.strictEqual(withBuildProfile({}, () => shouldSkipBuild(true, missing)), true);
	});

	it('the profile round-trips reuseBuild and drops unknown values', () => {
		assert.deepStrictEqual(withBuildProfile({ reuseBuild: 'if-present' }, () => buildProfile()), { reuseBuild: 'if-present' });
		process.env.BLOCKS_HOSTING_BUILD_PROFILE = JSON.stringify({ reuseBuild: 'always' });
		try {
			assert.deepStrictEqual(buildProfile(), {});
		} finally {
			delete process.env.BLOCKS_HOSTING_BUILD_PROFILE;
		}
	});
});
