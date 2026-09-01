// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import type {
	CronJobEvent,
	CronJobOptions,
} from './types.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { BB_NAME, BB_VERSION } from './version.js';

export { CronJobErrors } from './errors.js';
export type { CronJobEvent, CronJobOptions } from './types.js';

import { parseScheduleForMock, validateTimezone, type CronFields, type RateSchedule, type CronSchedule } from './schedule.js';

/**
 * Scheduled task execution backed by EventBridge Scheduler and Lambda.
 *
 * **When to use:** You need to run code on a recurring schedule — cleanup
 * jobs, report generation, data syncs, cache warming, or periodic health checks.
 *
 * **When NOT to use:** If you need to run a one-off async task triggered by
 * an event or user action, use `AsyncJob`.
 *
 * **Best practices:**
 * - Keep handlers idempotent — schedules can fire twice in rare cases
 * - Use rate expressions for simple intervals (`rate(5 minutes)`)
 * - Use cron expressions for precise timing (`cron(0 9 * * ? *)`)
 * - Set `enabled: false` for jobs you only want to trigger manually during development
 *
 * **Failure handling (preview):** Handler exceptions are retried by Lambda's
 * built-in async invoke retry policy (2 retries with exponential backoff).
 * Dead-letter queues and configurable retry policies are planned for GA.
 *
 * **Concurrent executions (preview):** If a handler runs longer than the
 * schedule interval, the next invocation starts while the previous is still
 * running. Design handlers to tolerate concurrent execution.
 *
 * @example
 * ```typescript
 * const cleanup = new CronJob(scope, 'cleanup', {
 *   schedule: 'rate(1 hour)',
 *   handler: async (event) => {
 *     console.log(`Running cleanup at ${event.scheduledTime}`);
 *   },
 * });
 * ```
 */
export class CronJob<T = void> extends Scope {
	private _handler: (event: CronJobEvent<T>) => Promise<void>;
	private _input: T | undefined;
	private _timezone: string | undefined;
	private _timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null = null;
	private _schedule: RateSchedule | CronSchedule;
	private _enabled: boolean;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options: CronJobOptions<T>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this._handler = options.handler;
		this._input = options.input;
		this._timezone = options.timezone;
		this._enabled = options.enabled !== false;
		registerSdkIdentifiers(this.fullId, { scheduleName: `mock-${this.fullId}` });

		if (options.timezone) {
			validateTimezone(options.timezone);
		}

		this._schedule = parseScheduleForMock(options.schedule);

		if (this._enabled) {
			this._start();
		} else {
			console.log(`[CronJob:${this.id}] registered (disabled)`);
		}
	}

	private _start(): void {
		if (this._schedule.type === 'rate') {
			console.log(`[CronJob:${this.id}] scheduled: rate(${formatMs(this._schedule.intervalMs)})`);
			this._timer = setInterval(() => this._fire(), this._schedule.intervalMs);
			(this._timer as NodeJS.Timeout).unref();
		} else {
			this._scheduleCronTick();
		}
	}

	private _scheduleCronTick(): void {
		const now = new Date();
		const sched = this._schedule as CronSchedule;
		const next = nextCronTime(sched.fields, now, this._timezone);
		const delayMs = next.getTime() - now.getTime();
		const tzLabel = this._timezone ?? 'UTC';
		console.log(`[CronJob:${this.id}] next fire: ${next.toISOString()} ${tzLabel}`);
		this._timer = setTimeout(() => {
			this._fire();
			this._scheduleCronTick();
		}, Math.max(delayMs, 1000));
		(this._timer as NodeJS.Timeout).unref();
	}

	private _fire(): void {
		const event: CronJobEvent<T> = {
			scheduledTime: new Date().toISOString(),
			jobName: this.fullId,
			input: this._input as T,
		};
		console.log(`[CronJob:${this.id}] triggered at ${event.scheduledTime}`);
		this._handler(event).catch((err: any) => {
			console.error(`[CronJob:${this.id}] handler error: ${err?.message ?? err}`);
			console.warn(`[CronJob:${this.id}] In AWS, this invocation would be retried by Lambda's async invoke retry policy.`);
		});
	}
}

// ---------------------------------------------------------------------------
// Cron next-fire-time calculation
// ---------------------------------------------------------------------------

function nextCronTime(fields: CronFields, after: Date, timezone?: string): Date {
	// Work in the target timezone by converting to local components
	const candidate = new Date(after.getTime() + 60_000); // start 1 minute ahead
	candidate.setSeconds(0, 0);

	for (let i = 0; i < 525_600; i++) { // max 1 year of minutes
		const { minute, hour, day, month, dow } = getComponents(candidate, timezone);

		if (
			fields.minute.includes(minute) &&
			fields.hour.includes(hour) &&
			fields.month.includes(month + 1) &&
			(fields.dayOfMonth.length === 0 || fields.dayOfMonth.includes(day)) &&
			(fields.dayOfWeek.length === 0 || fields.dayOfWeek.includes(dow))
		) {
			return candidate;
		}

		candidate.setTime(candidate.getTime() + 60_000);
	}

	// Fallback: 1 hour from now
	return new Date(after.getTime() + 3_600_000);
}

function getComponents(date: Date, timezone?: string): { minute: number; hour: number; day: number; month: number; dow: number } {
	if (!timezone) {
		return { minute: date.getUTCMinutes(), hour: date.getUTCHours(), day: date.getUTCDate(), month: date.getUTCMonth(), dow: date.getUTCDay() };
	}
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		hour: 'numeric', minute: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short',
		hour12: false,
	}).formatToParts(date);

	const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
	const dowStr = parts.find(p => p.type === 'weekday')?.value ?? 'Sun';
	const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

	return { minute: get('minute'), hour: get('hour'), day: get('day'), month: get('month') - 1, dow: dowMap[dowStr] ?? 0 };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
	if (ms >= 86_400_000) return `${ms / 86_400_000} day(s)`;
	if (ms >= 3_600_000) return `${ms / 3_600_000} hour(s)`;
	return `${ms / 60_000} minute(s)`;
}
