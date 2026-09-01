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

// EventBridge requires lowercase `rate`/`cron`, so both are case-sensitive (no /i).
const RATE_RE = /^rate\((\d+)\s+(minutes?|hours?|days?)\)$/;
const CRON_RE = /^cron\((.+)\)$/;

function scheduleError(expr: string): Error {
	// Name the actual constraint. A `rate(`-shaped expression that got here failed the
	// unit/value rules (e.g. the flagship `rate(10 seconds)`), so point at those.
	const detail = /^rate\s*\(/.test(expr)
		? 'a rate must be "rate(<n> minute|minutes|hour|hours|day|days)" with n ≥ 1 (EventBridge’s minimum is 1 minute; seconds are not supported)'
		: 'expected "rate(<n> minutes|hours|days)" or a 6-field "cron(...)" expression';
	const err = new Error(`${CronJobErrors.InvalidSchedule}: "${expr}" is not a valid schedule — ${detail}`);
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

/**
 * Parse a schedule for the **mock's local firing**, distinguishing "invalid" from
 * "valid but not simulatable locally". If {@link parseSchedule} can't parse the
 * expression but the synth gate ({@link validateSchedule}) accepts it, the
 * expression is a valid EventBridge schedule the mock just can't model (e.g. a
 * cron with `L`/`W`/`#` or a year field) — surface that as
 * `CronJobErrors.ScheduleNotSupported`, so local dev doesn't call a deployable
 * schedule "invalid".
 */
export function parseScheduleForMock(expr: string): ParsedSchedule {
	try {
		return parseSchedule(expr);
	} catch (err) {
		// Reclassify as "unsupported in mock" ONLY when the parse failure is
		// attributable to an advanced cron form (L/W/#, year) AND the rest of the
		// expression is otherwise well-formed. A genuinely bad field (minute 100,
		// an inverted range) must still throw InvalidSchedule even when a year or
		// marker is also present — otherwise we'd claim a deploy-doomed schedule
		// "will deploy". We test this by normalizing the markers/year to valid
		// placeholders and re-parsing: if it now parses, the marker was the only
		// problem; if it still throws, a real field is bad.
		const normalized = normalizeUnsupportedCron(expr);
		if (normalized === null) throw err; // no advanced form → the failure is a genuine error
		try {
			parseSchedule(normalized);
		} catch {
			throw err; // a non-marker field is also invalid → keep InvalidSchedule
		}
		const e = new Error(
			`${CronJobErrors.ScheduleNotSupported}: "${expr}" is valid for EventBridge and will deploy, ` +
				'but the local mock cannot simulate it (advanced cron forms like L/W/#, or a year field). ' +
				'Deploy to a sandbox to exercise it.',
		);
		e.name = CronJobErrors.ScheduleNotSupported;
		throw e;
	}
}

/**
 * If `expr` is a 6-field cron using a form EventBridge supports but the mock
 * parser doesn't model (`L`/`W`/`#` in a day field, or an explicit non-`*`/`?`
 * year), return an equivalent expression with those markers/year replaced by
 * valid placeholders — so the OTHER fields' validity can be re-checked by
 * re-parsing. Returns `null` when the expression uses no such form (in which
 * case a parse failure is a genuine error, not a mock limitation).
 */
function normalizeUnsupportedCron(expr: string): string | null {
	const m = expr.match(CRON_RE);
	if (!m) return null;
	const fields = m[1].trim().split(/\s+/);
	if (fields.length !== 6) return null;
	let [minute, hour, dom, month, dow, year] = fields;
	const hasMarker = /[LW#]/i.test(dom) || /[LW#]/i.test(dow);
	const hasYear = year !== '*' && year !== '?';
	if (!hasMarker && !hasYear) return null;
	// Replace only the unsupported bits with valid placeholders; leave the rest so
	// a bad minute/hour/month/range still fails the re-parse.
	if (/[LW#]/i.test(dom)) dom = '1'; // valid day-of-month
	if (/[LW#]/i.test(dow)) dow = '?'; // valid day-of-week (mock treats ? as "any")
	year = '*';
	return `cron(${minute} ${hour} ${dom} ${month} ${dow} ${year})`;
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
