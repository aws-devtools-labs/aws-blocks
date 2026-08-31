// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { isBlocksError } from '@aws-blocks/core';
import { CronJobErrors } from './errors.js';
import { validateSchedule, validateTimezone } from './schedule.js';

describe('validateSchedule (synth-time guard)', () => {
	for (const ok of ['rate(1 minute)', 'rate(5 minutes)', 'rate(1 hour)', 'rate(7 days)', 'cron(0 9 * * ? *)']) {
		test(`accepts valid "${ok}"`, () => {
			assert.doesNotThrow(() => validateSchedule(ok));
		});
	}

	// rate(10 seconds) is the card's headline case — EventBridge's minimum is 1 minute.
	for (const bad of ['rate(10 seconds)', 'rate(0 minutes)', 'rate(1 minutes)', 'rate(5 minute)', 'every 5 minutes', 'cron(0 9 * * *)', 'cron(99 9 * * ? *)', '']) {
		test(`rejects invalid "${bad}" with InvalidScheduleExpression`, () => {
			assert.throws(
				() => validateSchedule(bad),
				(e: unknown) => isBlocksError(e, CronJobErrors.InvalidSchedule),
			);
		});
	}
});

describe('validateTimezone (synth-time guard)', () => {
	test('accepts a valid IANA timezone', () => {
		assert.doesNotThrow(() => validateTimezone('America/New_York'));
	});
	test('rejects an invalid timezone', () => {
		assert.throws(
			() => validateTimezone('Mars/Phobos'),
			(e: unknown) => isBlocksError(e, CronJobErrors.InvalidTimezone),
		);
	});
});
