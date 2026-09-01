// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { isBlocksError } from '@aws-blocks/core';
import { CronJobErrors } from './errors.js';
import { parseScheduleForMock, validateSchedule, validateTimezone } from './schedule.js';

describe('validateSchedule (synth-time guard)', () => {
	// Includes advanced EventBridge cron the mock parser doesn't model (L, W, #, named-day
	// ranges, a year field). The synth gate must NOT reject these — see DESIGN.md D-CJ-4.
	const valid = [
		'rate(1 minute)', 'rate(5 minutes)', 'rate(1 hour)', 'rate(7 days)',
		'cron(0 9 * * ? *)',
		'cron(30 9 ? * MON-FRI *)', // README example (named day range)
		'cron(0 9 L * ? *)', // L = last day of month
		'cron(0 9 ? * 6#3 *)', // # = nth weekday
		'cron(0 9 ? * MON#1 *)', // named nth weekday
		'cron(0 0 1 1 ? 2025)', // explicit year
		'cron(0 0 1 1 ? 2025-2027)', // year range
	];
	for (const ok of valid) {
		test(`accepts valid "${ok}"`, () => {
			assert.doesNotThrow(() => validateSchedule(ok));
		});
	}

	// rate(10 seconds) is the card's headline case — EventBridge's minimum is 1 minute.
	// cron rejections here are structural only (wrong field count / not a rate|cron shape);
	// field-level semantics are deferred to EventBridge to avoid false negatives.
	// 'Rate(...)' / 'Cron(...)' are rejected: EventBridge requires lowercase, so the gate is case-sensitive.
	const invalid = ['rate(10 seconds)', 'rate(0 minutes)', 'rate(1 minutes)', 'rate(5 minute)', 'every 5 minutes', 'cron(0 9 * * *)', 'cron(0 9 * * ? * extra)', 'Rate(5 minutes)', 'CRON(0 9 * * ? *)', ''];
	for (const bad of invalid) {
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

describe('parseScheduleForMock (local firing) — distinguishes unsupported from invalid', () => {
	// Advanced EventBridge cron the gate accepts but the mock parser can't simulate:
	// surfaces as ScheduleNotSupported, NOT InvalidSchedule.
	for (const adv of ['cron(0 10 L * ? *)', 'cron(0 10 LW * ? *)']) {
		test(`"${adv}" → ScheduleNotSupported (not InvalidSchedule)`, () => {
			assert.throws(
				() => parseScheduleForMock(adv),
				(e: unknown) => isBlocksError(e, CronJobErrors.ScheduleNotSupported),
			);
		});
	}

	// Genuinely invalid stays InvalidSchedule — even when a year/marker is ALSO present,
	// a bad field must not be excused as "unsupported but deployable".
	for (const bad of [
		'rate(10 seconds)',
		'cron(0 9 * * *)',
		'nonsense',
		'cron(100 9 * * ? 2025)', // minute 100 invalid + year present
		'cron(0 9 30-10 * ? 2025)', // inverted day-of-month range + year present
	]) {
		test(`"${bad}" → InvalidSchedule`, () => {
			assert.throws(
				() => parseScheduleForMock(bad),
				(e: unknown) => isBlocksError(e, CronJobErrors.InvalidSchedule),
			);
		});
	}

	test('a schedule the mock CAN model parses fine', () => {
		assert.doesNotThrow(() => parseScheduleForMock('cron(0 9 ? * MON-FRI *)'));
		assert.doesNotThrow(() => parseScheduleForMock('rate(5 minutes)'));
	});
});
