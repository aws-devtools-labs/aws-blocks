// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { CronJob } from './index.mock.js';

const fakeScope = {
	_id: 'test',
	_children: [] as any[],
	addChild(c: any) {
		this._children.push(c);
	},
	get fullId() {
		return 'test';
	},
} as any;

describe('CronJob mock – schedules far in the future', () => {
	beforeEach(() => {
		mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-03-01T00:00:00Z') });
	});

	afterEach(() => {
		mock.timers.reset();
	});

	test('a leap-day schedule fires on the next leap day, not an hour later', () => {
		const fired: string[] = [];
		new CronJob(fakeScope, 'leap-day', {
			schedule: 'cron(0 0 29 2 ? *)',
			handler: async (event) => {
				fired.push(event.scheduledTime);
			},
		});

		mock.timers.tick(2 * 3_600_000);
		assert.deepStrictEqual(fired, []);

		const until = new Date('2028-03-01T00:00:00Z').getTime();
		while (Date.now() < until) {
			mock.timers.tick(Math.min(3_600_000, until - Date.now()));
		}
		assert.deepStrictEqual(fired, ['2028-02-29T00:00:00.000Z']);
	});

	test('a yearly schedule more than 24.8 days away waits for its date', () => {
		const fired: string[] = [];
		new CronJob(fakeScope, 'yearly', {
			schedule: 'cron(0 0 1 1 ? *)',
			handler: async (event) => {
				fired.push(event.scheduledTime);
			},
		});

		const until = new Date('2027-01-02T00:00:00Z').getTime();
		while (Date.now() < until) {
			mock.timers.tick(Math.min(3_600_000, until - Date.now()));
		}
		assert.deepStrictEqual(fired, ['2027-01-01T00:00:00.000Z']);
	});
});

describe('CronJob mock – schedules that cannot match', () => {
	beforeEach(() => {
		mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-03-01T00:00:00Z') });
	});

	afterEach(() => {
		mock.timers.reset();
		mock.restoreAll();
	});

	test('a schedule with no real date warns that it will never fire', () => {
		const warn = mock.method(console, 'warn', () => {});
		mock.method(console, 'log', () => {});
		new CronJob(fakeScope, 'feb-30', {
			schedule: 'cron(0 0 30 2 ? *)',
			handler: async () => {},
		});

		assert.strictEqual(warn.mock.callCount(), 1);
		assert.match(String(warn.mock.calls[0].arguments[0]), /never fire/);
	});

	test('a leap-day schedule only logs that it is checking again later', () => {
		const warn = mock.method(console, 'warn', () => {});
		mock.method(console, 'log', () => {});
		new CronJob(fakeScope, 'leap-day', {
			schedule: 'cron(0 0 29 2 ? *)',
			handler: async () => {},
		});

		assert.strictEqual(warn.mock.callCount(), 0);
	});
});
