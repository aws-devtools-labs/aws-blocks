// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBlocksError, Scope } from '@aws-blocks/core';
import { CronJob, CronJobErrors } from './index.mock.js';

for (const enabled of [true, false]) {
	for (const year of ['1970', '2099', '2099-2100', '2099,2101', '2099/2', '*/2']) {
		test(`CronJob rejects year ${year} before scheduling (enabled=${enabled})`, (t) => {
			const setTimeoutSpy = t.mock.method(globalThis, 'setTimeout');
			assert.throws(
				() => new CronJob(new Scope('year-test'), 'job', {
					schedule: `cron(* * * * ? ${year})`,
					enabled,
					handler: async () => {},
				}),
				(error: unknown) => isBlocksError(error, CronJobErrors.ScheduleNotSupported),
			);
			assert.equal(setTimeoutSpy.mock.callCount(), 0);
		});
	}
}

test('CronJob still accepts a wildcard year', () => {
	assert.doesNotThrow(() => new CronJob(new Scope('wildcard-year-test'), 'job', {
		schedule: 'cron(* * * * ? *)',
		enabled: false,
		handler: async () => {},
	}));
});
