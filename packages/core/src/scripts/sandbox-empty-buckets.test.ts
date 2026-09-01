// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { toDeleteObjects } from './sandbox.js';

// The teardown bucket-emptying must delete BOTH live versions and delete
// markers — a versioned bucket left with either still blocks `cdk destroy`.
// This is the exact combination that, done wrong, silently no-ops.
describe('toDeleteObjects', () => {
	it('combines versions and delete markers', () => {
		const out = toDeleteObjects({
			Versions: [
				{ Key: 'a', VersionId: 'v1' },
				{ Key: 'b', VersionId: 'v2' },
			],
			DeleteMarkers: [{ Key: 'a', VersionId: 'dm1' }],
		});
		assert.deepStrictEqual(out, [
			{ Key: 'a', VersionId: 'v1' },
			{ Key: 'b', VersionId: 'v2' },
			{ Key: 'a', VersionId: 'dm1' },
		]);
	});

	it('returns [] for an empty bucket (no Versions/DeleteMarkers keys)', () => {
		assert.deepStrictEqual(toDeleteObjects({}), []);
	});

	it('tolerates only versions or only delete markers', () => {
		assert.deepStrictEqual(toDeleteObjects({ Versions: [{ Key: 'x', VersionId: 'v' }] }), [
			{ Key: 'x', VersionId: 'v' },
		]);
		assert.deepStrictEqual(toDeleteObjects({ DeleteMarkers: [{ Key: 'y', VersionId: 'd' }] }), [
			{ Key: 'y', VersionId: 'd' },
		]);
	});

	it('drops entries without a Key rather than emitting a bad DeleteObjects payload', () => {
		assert.deepStrictEqual(toDeleteObjects({ Versions: [{ VersionId: 'orphan' }] }), []);
	});
});
