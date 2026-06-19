// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { CronJob, CronJobErrors } from './index.mock.js';

/**
 * Minimal scope parent stub satisfying the Scope base class contract.
 */
const fakeScope = {
	_id: 'test',
	_children: [] as any[],
	addChild(c: any) { this._children.push(c); },
	get fullId() { return 'test'; },
} as any;

function opts(schedule: string) {
	return { schedule, handler: async () => {} };
}

describe('parseSchedule – rate expressions', () => {
	test('rate(30 seconds) throws — seconds not supported by EventBridge', () => {
		assert.throws(
			() => new CronJob(fakeScope, 'sec', opts('rate(30 seconds)')),
			(err: Error) => err.name === CronJobErrors.InvalidSchedule
		);
	});

	test('rate(1 second) throws — seconds not supported', () => {
		assert.throws(
			() => new CronJob(fakeScope, 'sec1', opts('rate(1 second)')),
			(err: Error) => err.name === CronJobErrors.InvalidSchedule
		);
	});

	test('rate(1 minutes) throws — plural with value 1', () => {
		assert.throws(
			() => new CronJob(fakeScope, 'plural1', opts('rate(1 minutes)')),
			(err: Error) => err.name === CronJobErrors.InvalidSchedule
		);
	});

	test('rate(1 hours) throws — plural with value 1', () => {
		assert.throws(
			() => new CronJob(fakeScope, 'plural1h', opts('rate(1 hours)')),
			(err: Error) => err.name === CronJobErrors.InvalidSchedule
		);
	});

	test('rate(5 minute) throws — singular with value > 1', () => {
		assert.throws(
			() => new CronJob(fakeScope, 'sing5', opts('rate(5 minute)')),
			(err: Error) => err.name === CronJobErrors.InvalidSchedule
		);
	});

	test('rate(1 minute) is valid', () => {
		const job = new CronJob(fakeScope, 'r1m', opts('rate(1 minute)'));
		assert.ok(job);
	});

	test('rate(5 minutes) is valid', () => {
		const job = new CronJob(fakeScope, 'r5m', opts('rate(5 minutes)'));
		assert.ok(job);
	});

	test('rate(1 hour) is valid', () => {
		const job = new CronJob(fakeScope, 'r1h', opts('rate(1 hour)'));
		assert.ok(job);
	});

	test('rate(24 hours) is valid', () => {
		const job = new CronJob(fakeScope, 'r24h', opts('rate(24 hours)'));
		assert.ok(job);
	});

	test('rate(1 day) is valid', () => {
		const job = new CronJob(fakeScope, 'r1d', opts('rate(1 day)'));
		assert.ok(job);
	});

	test('rate(7 days) is valid', () => {
		const job = new CronJob(fakeScope, 'r7d', opts('rate(7 days)'));
		assert.ok(job);
	});
});

describe('parseSchedule – cron day-of-week numeric values', () => {
	// AWS cron DOW: 1=SUN, 2=MON, 3=TUE, 4=WED, 5=THU, 6=FRI, 7=SAT
	// JS getUTCDay(): 0=SUN, 1=MON, 2=TUE, 3=WED, 4=THU, 5=FRI, 6=SAT

	test('cron(0 9 ? * 2 *) resolves DOW=2 to Monday (JS 1)', () => {
		const job = new CronJob(fakeScope, 'dow2', opts('cron(0 9 ? * 2 *)')) as any;
		const fields = job._schedule.fields;
		assert.deepStrictEqual(fields.dayOfWeek, [1]);
	});

	test('cron(0 9 ? * 1 *) resolves DOW=1 to Sunday (JS 0)', () => {
		const job = new CronJob(fakeScope, 'dow1', opts('cron(0 9 ? * 1 *)')) as any;
		const fields = job._schedule.fields;
		assert.deepStrictEqual(fields.dayOfWeek, [0]);
	});

	test('cron(0 9 ? * 7 *) resolves DOW=7 to Saturday (JS 6)', () => {
		const job = new CronJob(fakeScope, 'dow7', opts('cron(0 9 ? * 7 *)')) as any;
		const fields = job._schedule.fields;
		assert.deepStrictEqual(fields.dayOfWeek, [6]);
	});

	test('cron(0 9 ? * 2-6 *) resolves to Mon-Fri (JS 1-5)', () => {
		const job = new CronJob(fakeScope, 'dow26', opts('cron(0 9 ? * 2-6 *)')) as any;
		const fields = job._schedule.fields;
		assert.deepStrictEqual(fields.dayOfWeek, [1, 2, 3, 4, 5]);
	});

	test('cron(0 9 ? * MON *) resolves to Monday (JS 1) — named days', () => {
		const job = new CronJob(fakeScope, 'dowMON', opts('cron(0 9 ? * MON *)')) as any;
		const fields = job._schedule.fields;
		assert.deepStrictEqual(fields.dayOfWeek, [1]);
	});

	test('cron(0 9 ? * SUN *) resolves to Sunday (JS 0) — named days', () => {
		const job = new CronJob(fakeScope, 'dowSUN', opts('cron(0 9 ? * SUN *)')) as any;
		const fields = job._schedule.fields;
		assert.deepStrictEqual(fields.dayOfWeek, [0]);
	});

	test('cron(0 9 ? * SAT *) resolves to Saturday (JS 6) — named days', () => {
		const job = new CronJob(fakeScope, 'dowSAT', opts('cron(0 9 ? * SAT *)')) as any;
		const fields = job._schedule.fields;
		assert.deepStrictEqual(fields.dayOfWeek, [6]);
	});

	test('cron(0 9 ? * MON-FRI *) resolves to Mon-Fri (JS 1-5) — named range', () => {
		const job = new CronJob(fakeScope, 'dowMF', opts('cron(0 9 ? * MON-FRI *)')) as any;
		const fields = job._schedule.fields;
		assert.deepStrictEqual(fields.dayOfWeek, [1, 2, 3, 4, 5]);
	});
});

describe('parseSchedule – cron step expressions', () => {
	test('cron(*/15 * * * ? *) expands minutes to every 15 across the whole field', () => {
		const job = new CronJob(fakeScope, 'step15', opts('cron(*/15 * * * ? *)')) as any;
		assert.deepStrictEqual(job._schedule.fields.minute, [0, 15, 30, 45]);
	});

	test('cron(0-30/10 * * * ? *) bounds a stepped range by the range upper end', () => {
		// Regression: `0-30/10` must stop at 30, not continue to the field max (59).
		const job = new CronJob(fakeScope, 'stepRange', opts('cron(0-30/10 * * * ? *)')) as any;
		assert.deepStrictEqual(job._schedule.fields.minute, [0, 10, 20, 30]);
	});

	test('cron(0 1-23/6 * * ? *) bounds a stepped hour range by its upper end', () => {
		const job = new CronJob(fakeScope, 'stepHour', opts('cron(0 1-23/6 * * ? *)')) as any;
		assert.deepStrictEqual(job._schedule.fields.hour, [1, 7, 13, 19]);
	});

	test('cron(15/30 * * * ? *) steps from a single start value to the field max', () => {
		const job = new CronJob(fakeScope, 'stepStart', opts('cron(15/30 * * * ? *)')) as any;
		assert.deepStrictEqual(job._schedule.fields.minute, [15, 45]);
	});

	test('cron(30-10/5 * * * ? *) throws — inverted stepped range', () => {
		assert.throws(
			() => new CronJob(fakeScope, 'invStep', opts('cron(30-10/5 * * * ? *)')),
			(err: Error) => err.name === CronJobErrors.InvalidSchedule
		);
	});

	test('cron(0-100/5 * * * ? *) throws — stepped range exceeds field max', () => {
		assert.throws(
			() => new CronJob(fakeScope, 'oobStep', opts('cron(0-100/5 * * * ? *)')),
			(err: Error) => err.name === CronJobErrors.InvalidSchedule
		);
	});

	test('cron(30-10 * * * ? *) throws — inverted range', () => {
		assert.throws(
			() => new CronJob(fakeScope, 'invRange', opts('cron(30-10 * * * ? *)')),
			(err: Error) => err.name === CronJobErrors.InvalidSchedule
		);
	});

	test('cron(100 * * * ? *) throws — minute out of bounds', () => {
		assert.throws(
			() => new CronJob(fakeScope, 'oobMin', opts('cron(100 * * * ? *)')),
			(err: Error) => err.name === CronJobErrors.InvalidSchedule
		);
	});
});
