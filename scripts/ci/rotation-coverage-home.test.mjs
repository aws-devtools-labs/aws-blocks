// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Checks that the rotating path's deploy coverage sits in exactly one test app.
// It belongs to the vpc-smoke lane, whose scripts only echo while
// https://github.com/aws-devtools-labs/aws-blocks/issues/987 is open, so the
// comprehensive app carries `secretRotation: true` meanwhile. That costs every
// comprehensive teardown the minutes a rotation Lambda's network interfaces
// take to release, so this test fails the moment the vpc-smoke lane runs again
// and tells whoever switched it on to drop the option from the other app. A
// comment cannot do that: nothing reads it.
//
// Static: it reads the sources, so it needs no build and no AWS access.
//
// Run: node --test scripts/ci/rotation-coverage-home.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const SMOKE_PKG = JSON.parse(read('test-apps/vpc-smoke/package.json'));
const SMOKE_APP = read('test-apps/vpc-smoke/aws-blocks/index.ts');
const COMPREHENSIVE_APP = read('test-apps/comprehensive/aws-blocks/index.ts');

// Matches the option only where it is live code: a commented-out one still
// reads as `secretRotation: true` to a plain search, which would let the
// coverage be removed while this test stayed green.
const optsIn = (src) =>
	src
		.split('\n')
		.some((line) => !line.trimStart().startsWith('//') && /secretRotation:\s*true/.test(line));

// What every lane that really runs its suite invokes: a runner directly, or the
// package's own test script. Keyed on this rather than on the stub's wording,
// which #987 may reword while still running nothing.
const RUNS_TESTS = /\btsx\b|node\s+--test|\bvitest\b|\bjest\b|npm\s+run\s+test/;

describe('rotation deploy coverage lives in one app', () => {
	const stages = ['test:e2e:local', 'test:e2e:sandbox', 'test:e2e:production'];

	it('knows which lane owns the assertion', () => {
		const stubbed = stages.filter((s) => !RUNS_TESTS.test(SMOKE_PKG.scripts?.[s] ?? ''));
		const optedIn = optsIn(COMPREHENSIVE_APP);

		if (stubbed.length === stages.length) {
			// #987 still open: the comprehensive app has to carry the coverage.
			assert.ok(
				optedIn,
				'test-apps/vpc-smoke cannot run its tests yet (issue #987), so the comprehensive ' +
					"app must keep `secretRotation: true` or no lane deploys a rotating cluster",
			);
			return;
		}

		// The vpc-smoke lane runs again, so it owns the assertion and has to carry
		// the option itself before the other app may drop it.
		assert.ok(
			optsIn(SMOKE_APP),
			'test-apps/vpc-smoke runs its tests again, so its own app must keep ' +
				'`secretRotation: true` or the rotating path has no deploy coverage at all',
		);
		assert.equal(
			optedIn,
			false,
			`test-apps/vpc-smoke runs its tests again (${stages.length - stubbed.length} of ` +
				`${stages.length} scripts invoke a runner), so drop \`secretRotation: true\` from ` +
				'test-apps/comprehensive/aws-blocks/index.ts: that lane pays minutes of teardown for ' +
				"the rotation Lambda's network interfaces, and vpc-smoke now covers the path",
		);
	});
});
