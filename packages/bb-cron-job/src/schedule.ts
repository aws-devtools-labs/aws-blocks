// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Schedule parsing and validation for CronJob, shared by the mock (which parses
 * the expression to fire locally) and the CDK layer (which validates it at synth
 * so an invalid `rate()`/`cron()` fails fast instead of being rejected by
 * EventBridge minutes into a deploy).
 */
import { CronJobErrors } from './errors.js';

/** Parsed rate expression. */
export interface RateSchedule {
	type: 'rate';
	intervalMs: number;
}
/** Parsed cron expression. */
export interface CronSchedule {
	type: 'cron';
	fields: CronFields;
}
export interface CronFields {
	minute: number[];
	hour: number[];
	dayOfMonth: number[];
	month: number[];
	dayOfWeek: number[];
}
export type ParsedSchedule = RateSchedule | CronSchedule;

const RATE_RE = /^rate\((\d+)\s+(minutes?|hours?|days?)\)$/i;
const CRON_RE = /^cron\((.+)\)$/;

function scheduleError(expr: string): Error {
	const err = new Error(`${CronJobErrors.InvalidSchedule}: "${expr}" is not a valid cron or rate expression`);
	err.name = CronJobErrors.InvalidSchedule;
	return err;
}

/**
 * Parse an EventBridge `rate(...)` or `cron(...)` schedule expression into a
 * structured form, throwing `CronJobErrors.InvalidSchedule` when it is not a
 * valid rate or 6-field AWS cron expression.
 */
export function parseSchedule(expr: string): ParsedSchedule {
	const rateMatch = expr.match(RATE_RE);
	if (rateMatch) {
		return { type: 'rate', intervalMs: parseRate(rateMatch, expr) };
	}

	const cronMatch = expr.match(CRON_RE);
	if (cronMatch) {
		return { type: 'cron', fields: parseCronFields(cronMatch[1], expr) };
	}

	throw scheduleError(expr);
}

/** Validate a `rate(...)` match and return its interval in ms. Throws on a bad unit/value. */
function parseRate(rateMatch: RegExpMatchArray, expr: string): number {
	const value = parseInt(rateMatch[1], 10);
	const rawUnit = rateMatch[2].toLowerCase();
	const unit = rawUnit.replace(/s$/, '');
	const isPlural = rawUnit.endsWith('s');
	if (value === 1 && isPlural) throw scheduleError(expr);
	if (value > 1 && !isPlural) throw scheduleError(expr);
	const multipliers: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
	const ms = multipliers[unit];
	if (!ms || value <= 0) throw scheduleError(expr);
	return value * ms;
}

/**
 * Validate a schedule expression for the **synth gate** (the CDK layer), throwing
 * `CronJobErrors.InvalidSchedule` for expressions EventBridge is guaranteed to
 * reject, without rejecting advanced-but-valid cron the mock parser doesn't model.
 *
 * Deliberately **more lenient than {@link parseSchedule}** (which the mock uses to
 * actually fire locally). Because this gates the deploy, it must not produce
 * false negatives (see DESIGN.md D-CJ-4):
 * - `rate(...)`: fully validated (unit ∈ minute/hour/day, plural agreement, value ≥ 1)
 *   — this is where `rate(10 seconds)` and friends are caught.
 * - `cron(...)`: only the **6-field shape** is checked; field-level semantics
 *   (`L`/`W`/`#`, year ranges, named days) are left to EventBridge, since the mock
 *   models only a subset and gating on it would reject valid schedules.
 */
export function validateSchedule(expr: string): void {
	const rateMatch = expr.match(RATE_RE);
	if (rateMatch) {
		parseRate(rateMatch, expr); // throws on an invalid rate; interval unused here
		return;
	}
	const cronMatch = expr.match(CRON_RE);
	if (cronMatch) {
		// AWS/EventBridge cron is 6 fields: minute hour day-of-month month day-of-week year.
		if (cronMatch[1].trim().split(/\s+/).length !== 6) throw scheduleError(expr);
		return;
	}
	throw scheduleError(expr);
}

/** Throw `CronJobErrors.InvalidTimezone` if `tz` is not a valid IANA timezone. */
export function validateTimezone(tz: string): void {
	try {
		Intl.DateTimeFormat('en-US', { timeZone: tz });
	} catch {
		const err = new Error(`${CronJobErrors.InvalidTimezone}: "${tz}" is not a valid IANA timezone`);
		err.name = CronJobErrors.InvalidTimezone;
		throw err;
	}
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
			let lo: number;
			let hi = max;
			if (base === '*') {
				lo = min;
			} else if (base.includes('-')) {
				const [loStr, hiStr] = base.split('-');
				lo = Number(loStr);
				hi = Number(hiStr);
			} else {
				lo = parseInt(base, 10);
			}
			if (isNaN(step) || step <= 0) throw scheduleError(original);
			assertBounds(lo, hi, min, max, original);
			for (let i = lo; i <= hi; i += step) values.push(i);
		} else if (part.includes('-')) {
			const [lo, hi] = part.split('-').map(Number);
			assertBounds(lo, hi, min, max, original);
			for (let i = lo; i <= hi; i++) values.push(i);
		} else {
			const n = parseInt(part, 10);
			assertBounds(n, n, min, max, original);
			values.push(n);
		}
	}
	return values;
}

function expandDow(field: string, original: string): number[] {
	// AWS cron uses 1-7 (1=SUN). Convert named days to AWS numeric equivalents first,
	// then expand and convert everything from AWS 1-7 to JS 0-6 via (d - 1) % 7.
	const dayMap: Record<string, number> = { SUN: 1, MON: 2, TUE: 3, WED: 4, THU: 5, FRI: 6, SAT: 7 };
	const replaced = field.replace(/SUN|MON|TUE|WED|THU|FRI|SAT/gi, (m) => String(dayMap[m.toUpperCase()]));
	return expandField(replaced, 1, 7, original).map((d) => (d - 1) % 7);
}

// Reject ranges that are non-numeric, inverted (`30-10`), or fall outside the
// field's valid `[min, max]` window (e.g. minute `100`). Without this an
// inverted range silently yields [] and an out-of-bounds upper end (`0-100`)
// produces values EventBridge would never accept.
function assertBounds(lo: number, hi: number, min: number, max: number, original: string): void {
	if (isNaN(lo) || isNaN(hi) || lo > hi || lo < min || hi > max) throw scheduleError(original);
}

function range(lo: number, hi: number): number[] {
	const r: number[] = [];
	for (let i = lo; i <= hi; i++) r.push(i);
	return r;
}
