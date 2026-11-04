// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SettingEntry, SettingVersion } from '../contract/v1.js';
import {
	editability,
	groupByFile,
	initialInput,
	initialKind,
	refusalIsFixableHere,
	restorableVersions,
	valueSummary,
} from './settings-page-view.js';

function entry(overrides: Partial<SettingEntry> = {}): SettingEntry {
	return {
		fullId: 'shop-flag',
		id: 'flag',
		file: 'aws-blocks/index.ts',
		line: 3,
		address: '/shop-flag',
		presence: 'present',
		secret: false,
		hasSchema: false,
		external: false,
		nameSource: 'derived',
		...overrides,
	};
}

describe('editability', () => {
	it('allows writing a setting the stage does not hold, which creates it', () => {
		// The fix for a parameter deleted out of band is to write it again, so
		// refusing here would block the one repair the page can perform.
		assert.deepEqual(editability(entry({ presence: 'absent' })), { editable: true });
	});

	it('refuses a setting whose path cannot be read from source', () => {
		const result = editability(entry({ address: undefined, nameSource: 'unresolved' }));

		assert.equal(result.editable, false);
		assert.match(result.reason ?? '', /variable/);
	});
});

describe('initialInput', () => {
	/**
	 * A secret's editor starts empty, always. Pre-filling it could only show a
	 * mask (which the user might save back over the real value) or require
	 * decrypting on page load, which is what the read path avoids.
	 */
	it('starts empty for a secret even when a value is held', () => {
		assert.equal(
			initialInput(entry({ secret: true, value: { display: '•••redacted•••', masked: true } })),
			'',
		);
	});

	/**
	 * Independently of the masking: a declared secret's editor starts empty even
	 * if a value somehow arrived unmasked, because the box is write-only and
	 * saving what was shown is the mistake to prevent.
	 */
	it('starts empty for a secret even when a value arrived unmasked', () => {
		assert.equal(initialInput(entry({ secret: true, value: { display: 'leaked', masked: false } })), '');
	});

	it('starts empty for a masked value nobody declared secret', () => {
		assert.equal(initialInput(entry({ value: { display: '•••redacted•••', masked: true } })), '');
	});

	it('starts from the stored value when it is actually shown', () => {
		assert.equal(initialInput(entry({ value: { display: 'on', masked: false } })), 'on');
	});
});

describe('initialKind', () => {
	it('reads the kind from what is stored rather than guessing at the text', () => {
		assert.equal(initialKind(entry({ value: { display: '{"retries":3}', masked: false } })), 'json');
		assert.equal(initialKind(entry({ value: { display: '[1,2]', masked: false } })), 'json');
		assert.equal(initialKind(entry({ value: { display: 'on', masked: false } })), 'text');
	});

	it('defaults to text when there is nothing to read', () => {
		// Text is the choice that cannot silently change a type: `5` stays "5".
		assert.equal(initialKind(entry({ secret: true })), 'text');
		assert.equal(initialKind(entry({ value: undefined })), 'text');
	});
});

describe('restorableVersions', () => {
	const versions: SettingVersion[] = [
		{ version: 3, display: 'c' },
		{ version: 2, display: 'b' },
		{ version: 1 },
	];

	it('offers nothing for a secret, whose history carries no value', () => {
		// History is read without decryption, so there is nothing to restore and
		// a button that cannot work is worse than no button.
		assert.deepEqual(restorableVersions(entry({ secret: true }), versions), []);
	});

	it('drops the version already in the box, and any with no value', () => {
		const current = entry({ value: { display: 'c', masked: false, version: 3 } });

		assert.deepEqual(
			restorableVersions(current, versions).map((version) => version.version),
			[2],
		);
	});
});

describe('valueSummary', () => {
	it('says why a field is blank rather than leaving it ambiguous', () => {
		assert.equal(valueSummary(entry({ presence: 'absent', valueHidden: 'not-present' })), 'not set in this stage');
		assert.equal(
			valueSummary(entry({ address: undefined, valueHidden: 'unaddressable' })),
			'path not readable from source',
		);
		assert.equal(valueSummary(entry({ valueHidden: 'unreadable', error: 'throttled' })), 'throttled');
	});

	it('shows the value when there is one', () => {
		assert.equal(valueSummary(entry({ value: { display: 'on', masked: false } })), 'on');
	});
});

describe('refusalIsFixableHere', () => {
	it('separates what the user can retype from what they cannot', () => {
		assert.equal(refusalIsFixableHere('invalid-json'), true);
		assert.equal(refusalIsFixableHere('too-large'), true);
		assert.equal(refusalIsFixableHere('empty-secret'), true);
		assert.equal(refusalIsFixableHere('version-conflict'), false);
		assert.equal(refusalIsFixableHere('LOCKED'), false);
		assert.equal(refusalIsFixableHere(undefined), false);
	});
});

describe('groupByFile', () => {
	it('keeps declaration order within and across files', () => {
		const grouped = groupByFile([
			entry({ fullId: 'a', file: 'aws-blocks/index.ts' }),
			entry({ fullId: 'b', file: 'aws-blocks/other.ts' }),
			entry({ fullId: 'c', file: 'aws-blocks/index.ts' }),
		]);

		assert.deepEqual(
			grouped.map((group) => [group.file, group.entries.map((item) => item.fullId)]),
			[
				['aws-blocks/index.ts', ['a', 'c']],
				['aws-blocks/other.ts', ['b']],
			],
		);
	});
});
