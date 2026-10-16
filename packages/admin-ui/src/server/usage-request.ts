// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Request parsing for the usage view, kept out of the route for the reason
 * every other pillar's logic is: the route handlers in `app/` are compiled by
 * Next and are not part of the server build, so logic placed there cannot be
 * unit tested. A route stays a thin shell (authorise, parse, delegate), and the
 * decisions it makes live here where they are assertable.
 *
 * The consent check is the one piece of this dashboard where a parsing mistake
 * spends the user's money, so it is a named function with its own tests rather
 * than an inline comparison.
 */

/** Default window: a week, which the period table resolves to hourly points. */
export const DEFAULT_RANGE_MINUTES = 7 * 24 * 60;

/** Floor on a requested window: below this, CloudWatch has no finer resolution. */
export const MIN_RANGE_MINUTES = 5;

/** Ceiling: CloudWatch retains metric data for 15 months. */
export const MAX_RANGE_MINUTES = 15 * 30 * 24 * 60;

/**
 * Whether the caller consented to a PRICED call.
 *
 * Exact `true` only. `?confirm` alone yields the empty string, and `1`, `yes`
 * and `TRUE` are all plausible hand-typed variants: none is consent, because a
 * gate that opens on a near-miss is not a gate. Being strict costs a user one
 * clear click and costs a mistake nothing.
 */
export function isConfirmed(raw: string | null): boolean {
	return raw === 'true';
}

/**
 * Parses the window, falling back to the default rather than erroring.
 *
 * A bad `rangeMinutes` is a mistake about presentation, not about money: the
 * estimate is driven by how many METRICS are requested, which the window does
 * not change. There is therefore nothing to protect by refusing the request,
 * and a chart with a sane default beats an error page.
 */
export function parseRangeMinutes(raw: string | null): number {
	if (raw === null) return DEFAULT_RANGE_MINUTES;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed)) return DEFAULT_RANGE_MINUTES;
	if (parsed < MIN_RANGE_MINUTES || parsed > MAX_RANGE_MINUTES) return DEFAULT_RANGE_MINUTES;
	return parsed;
}
