// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { Scope } from '@aws-blocks/core';
import { CronJob } from './index.mock.js';

const MAX_TIMER_DELAY = 2_147_483_647;
const DAY = 86_400_000;

function clock(t: TestContext, now: string) {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: new Date(now) });
	const timeout = t.mock.method(globalThis, 'setTimeout');
	const interval = t.mock.method(globalThis, 'setInterval');

	function assertBoundedTimers() {
		// Mock timers do not apply Node's overflow clamp; inspect the actual arguments too.
		for (const call of [...timeout.mock.calls, ...interval.mock.calls]) {
			const delay = call.arguments[1];
			assert.ok(
				typeof delay === 'number' && delay > 0 && delay <= MAX_TIMER_DELAY,
				`Timer delay ${delay} exceeds Node's supported range`,
			);
		}
	}

	return {
		timeout,
		interval,
		assertBoundedTimers,
		tick(ms: number) {
			t.mock.timers.tick(ms);
			assertBoundedTimers();
		},
	};
}

test('a 30-day rate waits the full interval and repeats without overflowing', (t) => {
	const timer = clock(t, '2026-01-01T00:00:00Z');
	const fired: string[] = [];
	new CronJob(new Scope('long-rate'), 'job', {
		schedule: 'rate(30 days)',
		handler: async (event) => {
			fired.push(event.scheduledTime);
		},
	});
	timer.assertBoundedTimers();

	for (let period = 1; period <= 2; period++) {
		timer.tick(MAX_TIMER_DELAY);
		assert.equal(fired.length, period - 1);
		timer.tick(30 * DAY - MAX_TIMER_DELAY - 1);
		assert.equal(fired.length, period - 1);
		timer.tick(1);
		assert.equal(fired.length, period);
	}
	assert.deepEqual(fired, ['2026-01-31T00:00:00.000Z', '2026-03-02T00:00:00.000Z']);
});

test('a monthly cron waits until the matching date and schedules the next month', (t) => {
	const timer = clock(t, '2026-01-01T00:00:00Z');
	const fired: string[] = [];
	new CronJob(new Scope('monthly-cron'), 'job', {
		schedule: 'cron(0 0 1 * ? *)',
		handler: async (event) => {
			fired.push(event.scheduledTime);
		},
	});
	timer.assertBoundedTimers();
	for (const days of [31, 28]) {
		const previousCount = fired.length;
		timer.tick(MAX_TIMER_DELAY);
		assert.equal(fired.length, previousCount);
		timer.tick(days * DAY - MAX_TIMER_DELAY - 1);
		assert.equal(fired.length, previousCount);
		timer.tick(1);
		assert.equal(fired.length, previousCount + 1);
	}
	assert.deepEqual(fired, ['2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z']);
});

test('an annual cron can wait across multiple timer chunks', (t) => {
	const timer = clock(t, '2026-10-04T00:00:00Z');
	let calls = 0;
	new CronJob(new Scope('annual-cron'), 'job', {
		schedule: 'cron(0 0 1 1 ? *)',
		handler: async () => {
			calls++;
		},
	});
	timer.assertBoundedTimers();
	for (let chunk = 0; chunk < 3; chunk++) {
		timer.tick(MAX_TIMER_DELAY);
		assert.equal(calls, 0);
	}
	timer.tick(89 * DAY - 3 * MAX_TIMER_DELAY - 1);
	assert.equal(calls, 0);
	timer.tick(1);
	assert.equal(calls, 1);
});

test('rate intervals on either side of the timer limit do not fire early', (t) => {
	const timer = clock(t, '2026-01-01T00:00:00Z');
	const fired: number[] = [];
	for (const minutes of [35_791, 35_792]) {
		new CronJob(new Scope(`rate-${minutes}`), 'job', {
			schedule: `rate(${minutes} minutes)`,
			handler: async () => {
				fired.push(minutes);
			},
		});
	}
	timer.assertBoundedTimers();
	timer.tick(35_791 * 60_000 - 1);
	assert.deepEqual(fired, []);
	timer.tick(1);
	assert.deepEqual(fired, [35_791]);
	timer.tick(MAX_TIMER_DELAY - 35_791 * 60_000);
	assert.deepEqual(fired, [35_791]);
	timer.tick(35_792 * 60_000 - MAX_TIMER_DELAY - 1);
	assert.deepEqual(fired, [35_791]);
	timer.tick(1);
	assert.deepEqual(fired, [35_791, 35_792]);
});

test('short rate and cron schedules keep their existing recurrence', (t) => {
	const timer = clock(t, '2026-01-01T00:00:00Z');
	let rateCalls = 0;
	let cronCalls = 0;
	const scope = new Scope('short-schedules');
	new CronJob(scope, 'rate', {
		schedule: 'rate(1 minute)',
		handler: async () => {
			rateCalls++;
		},
	});
	new CronJob(scope, 'cron', {
		schedule: 'cron(* * * * ? *)',
		handler: async () => {
			cronCalls++;
		},
	});
	for (let minute = 1; minute <= 3; minute++) {
		timer.tick(59_999);
		assert.equal(rateCalls, minute - 1);
		assert.equal(cronCalls, minute - 1);
		timer.tick(1);
		assert.equal(rateCalls, minute);
		assert.equal(cronCalls, minute);
	}
	assert.equal(timer.interval.mock.callCount(), 1);
});

test('disabled long schedules do not allocate timers', (t) => {
	const timer = clock(t, '2026-01-01T00:00:00Z');
	for (const [id, schedule] of [
		['rate', 'rate(30 days)'],
		['cron', 'cron(0 0 1 1 ? *)'],
	]) {
		new CronJob(new Scope(`disabled-${id}`), 'job', { schedule, enabled: false, handler: async () => {} });
	}
	assert.equal(timer.timeout.mock.callCount(), 0);
	assert.equal(timer.interval.mock.callCount(), 0);
});

test('an early timer wake-up re-arms the wait without invoking the handler', (t) => {
	const timer = clock(t, '2026-01-01T00:00:00Z');
	let calls = 0;
	new CronJob(new Scope('early-wake-up'), 'job', {
		schedule: 'cron(0 0 1 * ? *)',
		handler: async () => {
			calls++;
		},
	});
	const first = timer.timeout.mock.calls[0];
	clearTimeout(first.result);
	first.arguments[0]();
	assert.equal(calls, 0);
	assert.equal(timer.timeout.mock.callCount(), 2);
	timer.assertBoundedTimers();
});

test('long schedules do not trigger Node overflow warnings or immediate invocations with real timers', () => {
	const mockModule = new URL('./index.mock.js', import.meta.url).href;
	const result = spawnSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
		import { Scope } from '@aws-blocks/core';
		import { CronJob } from ${JSON.stringify(mockModule)};
		const NativeDate = Date;
		class FixedDate extends NativeDate {
			constructor(...args) { super(...(args.length ? args : ['2026-01-01T00:00:00Z'])); }
			static now() { return NativeDate.parse('2026-01-01T00:00:00Z'); }
		}
		globalThis.Date = FixedDate;
		const timeout = globalThis.setTimeout;
		const interval = globalThis.setInterval;
		const timers = [];
		for (const [name, original] of [['setTimeout', timeout], ['setInterval', interval]]) {
			globalThis[name] = (callback, delay, ...args) => {
				const handle = original(callback, delay, ...args);
				timers.push({ handle, delay });
				return handle;
			};
		}
		let calls = 0;
		const scope = new Scope('native-timers');
		for (const [id, schedule] of [['rate', 'rate(30 days)'], ['cron', 'cron(0 0 1 * ? *)']]) {
			new CronJob(scope, id, { schedule, handler: async () => { calls++; } });
		}
		await new Promise(resolve => timeout(resolve, 30));
		const valid = calls === 0 && timers.length === 2 && timers.every(({ handle, delay }) =>
			delay > 0 && delay <= ${MAX_TIMER_DELAY} && !handle.hasRef());
		for (const { handle } of timers) { clearTimeout(handle); clearInterval(handle); }
		if (!valid) { console.error({ calls, delays: timers.map(t => t.delay) }); process.exitCode = 1; }
	`,
		],
		{ encoding: 'utf8', timeout: 10_000 },
	);
	assert.equal(result.status, 0, result.error?.message ?? result.stderr);
	assert.doesNotMatch(result.stderr, /TimeoutOverflowWarning/);
});
