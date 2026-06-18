// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import type {
	CronJobEvent,
	CronJobOptions,
} from './types.js';
import { CronJobErrors } from './errors.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { BB_NAME, BB_VERSION } from './version.js';

export { CronJobErrors } from './errors.js';
export type { CronJobEvent, CronJobOptions } from './types.js';

/** Parsed rate expression. */
interface RateSchedule { type: 'rate'; intervalMs: number }
/** Parsed cron expression. */
interface CronSchedule { type: 'cron'; fields: CronFields }
interface CronFields { minute: number[]; hour: number[]; dayOfMonth: number[]; month: number[]; dayOfWeek: number[] }

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

		this._schedule = parseSchedule(options.schedule);

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
// Schedule parsing
// ---------------------------------------------------------------------------

const RATE_RE = /^rate\((\d+)\s+(minutes?|hours?|days?)\)$/i;
const CRON_RE = /^cron\((.+)\)$/;

function parseSchedule(expr: string): RateSchedule | CronSchedule {
	const rateMatch = expr.match(RATE_RE);
	if (rateMatch) {
		const value = parseInt(rateMatch[1], 10);
		const rawUnit = rateMatch[2].toLowerCase();
		const unit = rawUnit.replace(/s$/, '');
		const isPlural = rawUnit.endsWith('s');
		if (value === 1 && isPlural) throw scheduleError(expr);
		if (value > 1 && !isPlural) throw scheduleError(expr);
		const multipliers: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
		const ms = multipliers[unit];
		if (!ms || value <= 0) throw scheduleError(expr);
		return { type: 'rate', intervalMs: value * ms };
	}

	const cronMatch = expr.match(CRON_RE);
	if (cronMatch) {
		return { type: 'cron', fields: parseCronFields(cronMatch[1], expr) };
	}

	throw scheduleError(expr);
}

function parseCronFields(body: string, original: string): CronFields {
	const parts = body.trim().split(/\s+/);
	// AWS cron: minute hour day-of-month month day-of-week year
	if (parts.length !== 6) throw scheduleError(original);

	return {
		minute: expandField(parts[0], 0, 59, original),
		hour: expandField(parts[1], 0, 23, original),
		dayOfMonth: parts[2] === '?' ? [] : expandField(parts[2], 1, 31, original),
		month: expandField(parts[3], 1, 12, original),
		dayOfWeek: parts[4] === '?' ? [] : expandDow(parts[4], original),
	};
	// parts[5] is year — ignored in mock
}

function expandField(field: string, min: number, max: number, original: string): number[] {
	if (field === '*') return range(min, max);
	const values: number[] = [];
	for (const part of field.split(',')) {
		if (part.includes('/')) {
			const [base, stepStr] = part.split('/');
			const step = parseInt(stepStr, 10);
			// `base` may be `*` (whole field), a single value (`15` → from 15 to
			// max), or a range (`0-30` → bounded by the range's upper end). A
			// stepped range must stop at the range's `hi`, not run to `max`.
			let start: number;
			let end = max;
			if (base === '*') {
				start = min;
			} else if (base.includes('-')) {
				const [lo, hi] = base.split('-').map(Number);
				if (isNaN(lo) || isNaN(hi)) throw scheduleError(original);
				start = lo;
				end = hi;
			} else {
				start = parseInt(base, 10);
			}
			if (isNaN(start) || isNaN(step) || step <= 0) throw scheduleError(original);
			for (let i = start; i <= end; i += step) values.push(i);
		} else if (part.includes('-')) {
			const [lo, hi] = part.split('-').map(Number);
			if (isNaN(lo) || isNaN(hi)) throw scheduleError(original);
			for (let i = lo; i <= hi; i++) values.push(i);
		} else {
			const n = parseInt(part, 10);
			if (isNaN(n)) throw scheduleError(original);
			values.push(n);
		}
	}
	return values;
}

function expandDow(field: string, original: string): number[] {
	// AWS cron uses 1-7 (1=SUN). Convert named days to AWS numeric equivalents first,
	// then expand and convert everything from AWS 1-7 to JS 0-6 via (d - 1) % 7.
	const dayMap: Record<string, number> = { SUN: 1, MON: 2, TUE: 3, WED: 4, THU: 5, FRI: 6, SAT: 7 };
	const replaced = field.replace(/SUN|MON|TUE|WED|THU|FRI|SAT/gi, m => String(dayMap[m.toUpperCase()]));
	return expandField(replaced, 1, 7, original).map(d => (d - 1) % 7);
}

function range(lo: number, hi: number): number[] {
	const r: number[] = [];
	for (let i = lo; i <= hi; i++) r.push(i);
	return r;
}

function scheduleError(expr: string): Error {
	const err = new Error(`${CronJobErrors.InvalidSchedule}: "${expr}" is not a valid cron or rate expression`);
	err.name = CronJobErrors.InvalidSchedule;
	return err;
}

// ---------------------------------------------------------------------------
// Timezone validation
// ---------------------------------------------------------------------------

function validateTimezone(tz: string): void {
	try {
		Intl.DateTimeFormat('en-US', { timeZone: tz });
	} catch {
		const err = new Error(`${CronJobErrors.InvalidTimezone}: "${tz}" is not a valid IANA timezone`);
		err.name = CronJobErrors.InvalidTimezone;
		throw err;
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
