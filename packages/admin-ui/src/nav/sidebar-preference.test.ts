// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	DEFAULT_SIDEBAR_STATE,
	SIDEBAR_ATTRIBUTE,
	SIDEBAR_STORAGE_KEY,
	isSidebarState,
	parseSidebarState,
	readStoredSidebarState,
	sidebarBootScript,
	sidebarToggleLabel,
	toggleSidebarState,
	writeStoredSidebarState,
} from './sidebar-preference.js';

describe('parseSidebarState', () => {
	it('accepts both real states', () => {
		assert.equal(parseSidebarState('collapsed'), 'collapsed');
		assert.equal(parseSidebarState('expanded'), 'expanded');
	});

	for (const raw of [null, undefined, '', 'COLLAPSED', 'true', '1', 'closed']) {
		it(`falls back to the default for ${JSON.stringify(raw)}`, () => {
			// Storage is user-writable and outlives any rename we make.
			assert.equal(parseSidebarState(raw), DEFAULT_SIDEBAR_STATE);
		});
	}

	it('defaults to expanded, so a first visit shows what the destinations are called', () => {
		assert.equal(DEFAULT_SIDEBAR_STATE, 'expanded');
	});
});

describe('isSidebarState', () => {
	it('rejects a boolean, which is the shape someone would reach for first', () => {
		assert.equal(isSidebarState(true), false);
	});
});

describe('toggleSidebarState', () => {
	it('flips both ways', () => {
		assert.equal(toggleSidebarState('expanded'), 'collapsed');
		assert.equal(toggleSidebarState('collapsed'), 'expanded');
	});
});

describe('readStoredSidebarState', () => {
	it('reads a stored value', () => {
		assert.equal(
			readStoredSidebarState(() => 'collapsed'),
			'collapsed',
		);
	});

	it('survives storage THROWING rather than returning null', () => {
		// The failure this exists to prevent: an unguarded read of this kind was
		// observed blanking every page with an uncaught `The operation is insecure.`
		assert.equal(
			readStoredSidebarState(() => {
				throw new DOMException('The operation is insecure.');
			}),
			DEFAULT_SIDEBAR_STATE,
		);
	});
});

describe('writeStoredSidebarState', () => {
	it('writes the state through', () => {
		const written: string[] = [];
		writeStoredSidebarState((value) => written.push(value), 'collapsed');
		assert.deepEqual(written, ['collapsed']);
	});

	it('swallows a refused write, because failing the click would be worse', () => {
		assert.doesNotThrow(() =>
			writeStoredSidebarState(() => {
				throw new DOMException('QuotaExceededError');
			}, 'collapsed'),
		);
	});
});

describe('sidebarToggleLabel', () => {
	it('names the ACTION, not the current state', () => {
		// A control labelled "Collapsed" leaves the reader guessing whether that is
		// what it is or what it will do.
		assert.match(sidebarToggleLabel('expanded'), /^Collapse/);
		assert.match(sidebarToggleLabel('collapsed'), /^Expand/);
	});
});

describe('sidebarBootScript', () => {
	/** Runs the generated source against stubbed globals, like the theme's does. */
	function run(stored: string | null | { throws: true }): { attribute?: string; value?: string } {
		const applied: { attribute?: string; value?: string } = {};
		const localStorage = {
			getItem(key: string) {
				if (typeof stored === 'object' && stored !== null && 'throws' in stored) {
					throw new DOMException('The operation is insecure.');
				}
				assert.equal(key, SIDEBAR_STORAGE_KEY);
				return stored;
			},
		};
		const document = {
			documentElement: {
				setAttribute(attribute: string, value: string) {
					applied.attribute = attribute;
					applied.value = value;
				},
			},
		};
		// Asserting the string CONTAINS its own constants would prove nothing, so the
		// script is executed.
		new Function('localStorage', 'document', sidebarBootScript())(localStorage, document);
		return applied;
	}

	it('applies a stored collapsed state before paint', () => {
		assert.deepEqual(run('collapsed'), { attribute: SIDEBAR_ATTRIBUTE, value: 'collapsed' });
	});

	it('applies expanded when nothing is stored', () => {
		assert.deepEqual(run(null), { attribute: SIDEBAR_ATTRIBUTE, value: 'expanded' });
	});

	it('falls back to the default for an unrecognised stored value', () => {
		assert.deepEqual(run('sideways'), { attribute: SIDEBAR_ATTRIBUTE, value: 'expanded' });
	});

	it('sets the attribute the stylesheet actually keys on', () => {
		assert.equal(run('collapsed').attribute, 'data-sidebar');
	});

	it('does not throw when storage refuses, leaving the default in place', () => {
		// The server renders expanded, so a failure here is invisible rather than
		// broken — but it must not throw, or nothing after it in <head> runs.
		assert.doesNotThrow(() => run({ throws: true }));
	});
});
