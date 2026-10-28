// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Set-Cookie handling shared by the Lambda handler and the local dev server,
 * so the two runtimes cannot drift.
 *
 * @internal
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Sun, 06 Nov 1994 08:49:37 GMT` — RFC 7231 §7.1.1.1 IMF-fixdate, exactly. */
const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;

/**
 * Parse a strict IMF-fixdate (the `Expires` format RFC 6265 §4.1.1 says servers
 * send) to epoch milliseconds, or `undefined` for anything else — including a
 * date that does not exist (`31 Feb`) or an out-of-range time. The day name is
 * not checked against the date; browsers ignore it, too.
 */
function parseImfFixdate(value: string): number | undefined {
	const m = IMF_FIXDATE.exec(value);
	if (!m) return undefined;
	const [, dd, mon, yyyy, hh, mm, ss] = m;
	const month = MONTHS.indexOf(mon);
	const day = Number(dd);
	const year = Number(yyyy);
	const hour = Number(hh);
	const minute = Number(mm);
	const second = Number(ss);
	if (month === -1 || hour > 23 || minute > 59 || second > 59) return undefined;
	const ms = Date.UTC(year, month, day, hour, minute, second);
	const check = new Date(ms);
	// Rejects day 00 and days past the month's end (Date.UTC would roll them over).
	if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) {
		return undefined;
	}
	return ms;
}

/**
 * Whether a `Set-Cookie` header value DELETES its cookie, i.e. its expiry is
 * already in the past, following RFC 6265 §5.2–5.3:
 *
 * - `Max-Age` with a value of zero or less deletes. `Max-Age` takes precedence
 *   over `Expires` when both are present (the last valid one of each counts).
 * - Otherwise an `Expires` date at or before `now` deletes.
 * - An attribute with a malformed value is ignored, as a browser would.
 * - A cookie with neither attribute is a live session cookie.
 *
 * Attributes are parsed after the first `;`, so text inside the cookie's
 * name/value (e.g. `a=Max-Age=0`) never counts.
 *
 * The check is deliberately **strict**, because a false "deletion" lets a live
 * cookie through on an error response: `Max-Age` must be an integer
 * (`-?digits`), and `Expires` must be a strict IMF-fixdate
 * (`Thu, 01 Jan 1970 00:00:00 GMT`, RFC 7231 §7.1.1.1). Anything looser
 * (`Expires=0`, an ISO date, the obsolete RFC 850 form) is not treated as a
 * deletion on its own, even where `Date.parse` would accept it — a strict reader
 * ignores such a value and keeps the cookie (and see below for when a lenient
 * one matters).
 *
 * **Every reasonable reading must delete.** A browser may read an attribute
 * this strict check ignores, and a later attribute it reads replaces an
 * earlier one (the last valid one counts). So the cookie is classed as a
 * deletion only when **every** combination of these readings deletes it — in
 * doubt, not a deletion, the safe side:
 *
 * - `Max-Age`: RFC 6265 §5.2.2 (a value that does not start with a digit or
 *   `-`, or has a non-digit after that — `abc`, `+999`, `999abc` — is ignored,
 *   and the decision falls to `Expires`), and a lenient integer parser that
 *   reads `[+-]?digits` from the front and drops the rest
 *   (`Max-Age=+999; Expires=<past>` would live 999 seconds there).
 * - `Expires`: the strict IMF-fixdate above; the RFC 6265 §5.1.1 cookie-date
 *   algorithm browsers implement (tokens in any order, `01-Jan-70`, a trailing
 *   zone or junk); and a free-form parser (`Date.parse`, standing in for the
 *   most lenient browser date parsers: ISO 8601, `Fri Jan 01 2100 …`). E.g.
 *   `Expires=<past IMF date>; Expires=Fri, 01-Jan-2100 00:00:00 GMT` is not a
 *   deletion: a browser keeps the later, readable, future date.
 *
 * @internal
 */
export function isCookieDeletion(setCookie: string, now: number = Date.now()): boolean {
	const attributes: Array<{ name: string; value: string }> = [];
	for (const raw of setCookie.split(';').slice(1)) {
		const eq = raw.indexOf('=');
		const name = (eq === -1 ? raw : raw.slice(0, eq)).trim().toLowerCase();
		const value = eq === -1 ? '' : raw.slice(eq + 1).trim();
		if (name === 'max-age' || name === 'expires') attributes.push({ name, value });
	}
	for (const readMaxAge of MAX_AGE_READINGS) {
		for (const readExpires of EXPIRES_READINGS) {
			let maxAge: number | undefined;
			let expires: number | undefined;
			for (const { name, value } of attributes) {
				const parsed = name === 'max-age' ? readMaxAge(value) : readExpires(value);
				if (parsed === undefined) continue;
				if (name === 'max-age') maxAge = parsed;
				else expires = parsed;
			}
			// RFC 6265 §5.3 step 3: Max-Age, when present, wins over Expires.
			const deletes = maxAge !== undefined ? maxAge <= 0 : expires !== undefined && expires <= now;
			if (!deletes) return false;
		}
	}
	return true;
}

/** How a `Max-Age` value may be read (seconds), or `undefined` when that reading ignores it. */
const MAX_AGE_READINGS: ReadonlyArray<(value: string) => number | undefined> = [
	// RFC 6265 §5.2.2: an optional leading '-' then digits; anything else is ignored.
	(value) => (/^-?\d+$/.test(value) ? Number(value) : undefined),
	// A lenient integer parser: a sign, digits from the front, the rest dropped.
	(value) => {
		const m = /^[+-]?\d+/.exec(value);
		return m ? Number(m[0]) : undefined;
	},
];

/** How an `Expires` value may be read (epoch ms), or `undefined` when that reading ignores it. */
const EXPIRES_READINGS: ReadonlyArray<(value: string) => number | undefined> = [
	parseImfFixdate,
	parseCookieDate,
	(value) => {
		const ms = Date.parse(value);
		return Number.isFinite(ms) ? ms : undefined;
	},
];

const MONTH_PREFIXES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * RFC 6265 §5.1.1, the cookie-date algorithm: split on delimiters, take the
 * first time (`h:m:s`), day of month, month (by its first three letters) and
 * year tokens in any order, each allowed trailing non-digit junk; a two-digit
 * year 70–99 is 19xx and 00–69 20xx. Epoch ms, or `undefined` when the
 * algorithm fails the date.
 */
function parseCookieDate(value: string): number | undefined {
	// delimiter = %x09 / %x20-2F / %x3B-40 / %x5B-60 / %x7B-7E
	const tokens = value.split(/[\t\x20-\x2F\x3B-\x40\x5B-\x60\x7B-\x7E]+/).filter((t) => t.length > 0);
	let time: [number, number, number] | undefined;
	let day: number | undefined;
	let month: number | undefined;
	let year: number | undefined;
	for (const token of tokens) {
		const t = time === undefined ? /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\D|$)/.exec(token) : null;
		if (t) {
			time = [Number(t[1]), Number(t[2]), Number(t[3])];
			continue;
		}
		const d = day === undefined ? /^(\d{1,2})(?:\D|$)/.exec(token) : null;
		if (d) {
			day = Number(d[1]);
			continue;
		}
		const mon = month === undefined ? MONTH_PREFIXES.indexOf(token.slice(0, 3).toLowerCase()) : -1;
		if (mon !== -1) {
			month = mon;
			continue;
		}
		const y = year === undefined ? /^(\d{2,4})(?:\D|$)/.exec(token) : null;
		if (y) year = Number(y[1]);
	}
	if (time === undefined || day === undefined || month === undefined || year === undefined) return undefined;
	if (year >= 70 && year <= 99) year += 1900;
	else if (year >= 0 && year <= 69) year += 2000;
	const [hour, minute, second] = time;
	if (day < 1 || day > 31 || year < 1601 || hour > 23 || minute > 59 || second > 59) return undefined;
	const ms = Date.UTC(year, month, day, hour, minute, second);
	// A day past the month's end fails the date (§5.1.1 step 6), as in parseImfFixdate.
	if (new Date(ms).getUTCDate() !== day) return undefined;
	return ms;
}

/**
 * The `Set-Cookie` values an RPC **error** response may carry: only those that
 * delete a cookie (see {@link isCookieDeletion}).
 *
 * A method that throws must still be able to clear state — e.g. `requireAuth`
 * rejecting a deleted user with a 401 and clearing its session cookie — but it
 * must never issue one. Otherwise a method that signs a user in and then
 * throws to reject them (a post-sign-in policy check) would hand that user a
 * live session alongside the error. Success responses and RawRoutes forward
 * every cookie; this filter applies only to RPC errors.
 *
 * @internal
 */
export function errorResponseSetCookies(responseHeaders: Headers | undefined, now: number = Date.now()): string[] {
	const all = responseHeaders?.getSetCookie?.() ?? [];
	return all.filter((c) => isCookieDeletion(c, now));
}
