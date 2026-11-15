// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_RANGE_MINUTES, isConfirmed, parseRangeMinutes } from './usage-request.js';

/*
 * The route owns exactly two decisions, and the first one spends money. These
 * test the parsing in isolation, where every rejected spelling of consent can
 * be enumerated rather than sampled.
 */
describe('usage route: consent', () => {
	it('accepts only the exact string true', () => {
		assert.equal(isConfirmed('true'), true);
	});

	it('refuses every other spelling, so a typo cannot open the gate', () => {
		// `?confirm` with no value arrives as '', and `?confirm=1` is a plausible
		// hand-typed variant. Neither is consent.
		for (const raw of ['', '1', 'yes', 'TRUE', 'True', 'on', 'false', ' true', 'true ', null]) {
			assert.equal(isConfirmed(raw), false, `"${raw}" must not count as consent`);
		}
	});
});

describe('usage route: range', () => {
	it('defaults to a week when absent', () => {
		assert.equal(parseRangeMinutes(null), DEFAULT_RANGE_MINUTES);
	});

	it('accepts a valid window', () => {
		assert.equal(parseRangeMinutes('60'), 60);
		assert.equal(parseRangeMinutes('1440'), 1440);
	});

	it('falls back to the default rather than failing the request', () => {
		// A bad window is a presentation mistake, not a money one: the estimate
		// depends on the metric COUNT, not on the time range.
		for (const raw of ['abc', '', 'NaN', 'Infinity', '1.5', '-60', '0', '99999999999']) {
			assert.equal(parseRangeMinutes(raw), DEFAULT_RANGE_MINUTES, `"${raw}" should fall back`);
		}
	});

	it('rejects a window below the floor and above metric retention', () => {
		assert.equal(parseRangeMinutes('4'), DEFAULT_RANGE_MINUTES);
		assert.equal(parseRangeMinutes('5'), 5);
		assert.equal(parseRangeMinutes(String(15 * 30 * 24 * 60)), 15 * 30 * 24 * 60);
		assert.equal(parseRangeMinutes(String(15 * 30 * 24 * 60 + 1)), DEFAULT_RANGE_MINUTES);
	});
});
