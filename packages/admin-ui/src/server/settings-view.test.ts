// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DiscoveredBlock } from '../contract/v1.js';
import { REDACTED } from './redact.js';
import { joinSettings } from './settings-inventory.js';
import type { StoredParameter } from './settings-store.js';
import { buildLocalSettingEntry, buildSettingEntry } from './settings-view.js';

function block(id: string, secret = false): DiscoveredBlock {
	return {
		type: 'AppSetting',
		id,
		fullId: `shop-${id}`,
		category: 'config',
		file: 'aws-blocks/index.ts',
		line: 1,
		setting: { parameterName: `/shop-${id}`, nameSource: 'derived', secret, hasSchema: false, external: false },
	};
}

/**
 * One row as the join produces it, so the view is tested on real input.
 *
 * The address is passed in the stack-prefixed form a deployed stack actually
 * creates, not the bare `/${fullId}` these fixtures used to assume: that
 * assumption is what hid the addressing bug a real deploy found.
 */
function row(id: string, secret = false, live: string[] = [`/stack-shop-${id}`]) {
	const inventory = joinSettings({
		blocks: [block(id, secret)],
		mode: 'cloud',
		live,
		addresses: new Map([[`shop-${id}`, `/stack-shop-${id}`]]),
	});
	const only = inventory.settings[0];
	assert.ok(only);
	return only;
}

describe('buildSettingEntry — what a reader may see', () => {
	it('shows a plain value', () => {
		const stored: StoredParameter = { raw: '"on"', type: 'String', version: 3, lastModified: '2026-10-14T09:00:00.000Z' };

		const entry = buildSettingEntry(row('flag'), stored);

		assert.deepEqual(entry.value, {
			display: 'on',
			masked: false,
			version: 3,
			lastModified: '2026-10-14T09:00:00.000Z',
			encoding: 'json',
		});
		assert.equal(entry.valueHidden, undefined);
	});

	it('masks a declared secret while keeping what a rollback needs', () => {
		const entry = buildSettingEntry(row('token', true), { type: 'SecureString', version: 7, lastModified: 'x' });

		assert.equal(entry.value?.display, REDACTED);
		assert.equal(entry.value?.masked, true);
		// The version and timestamp are not the secret, and they are what makes
		// a "last changed" column and a rollback target possible.
		assert.equal(entry.value?.version, 7);
		assert.equal(entry.valueHidden, 'secret');
	});

	/**
	 * The live type outranks the declaration. A parameter nobody declared
	 * secret that IS a SecureString in the account is masked on the strength of
	 * the account, because that is a fact about the data rather than a claim in
	 * source, and the declaration can be wrong (or undecidable).
	 */
	it('masks a parameter that is a SecureString in the account though nobody declared it one', () => {
		const entry = buildSettingEntry(row('flag'), { raw: 'AQICAHi...', type: 'SecureString', version: 1 });

		assert.equal(entry.value?.masked, true);
		assert.equal(entry.value?.display, REDACTED);
		// The ciphertext must not reach the response under any name.
		assert.ok(!JSON.stringify(entry).includes('AQICAHi'));
	});

	/**
	 * Second line of defence, and the reason a `String` parameter is not trusted
	 * just because nobody declared it secret: a developer who pastes a bearer
	 * token into a plain setting has created a credential the declaration knows
	 * nothing about. Shape catches that.
	 */
	it('masks a plain value whose shape is a credential', () => {
		const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
		const entry = buildSettingEntry(row('flag'), { raw: JSON.stringify(jwt), type: 'String' });

		assert.equal(entry.value?.masked, true);
		assert.ok(!JSON.stringify(entry).includes('eyJhbGciOiJIUzI1NiJ9'));
	});

	it('says a stage does not hold it rather than showing an empty field', () => {
		const entry = buildSettingEntry(row('flag', false, []), undefined);

		assert.equal(entry.value, undefined);
		assert.equal(entry.valueHidden, 'not-present');
		assert.equal(entry.presence, 'absent');
	});

	it('says it could not be addressed when the declaration names no path', () => {
		const declaration = block('db-url', true);
		declaration.setting = { nameSource: 'unresolved', secret: true, hasSchema: false, external: true };
		const inventory = joinSettings({ blocks: [declaration], mode: 'cloud', live: ['/seeded/db'], addresses: new Map() });
		const only = inventory.settings[0];
		assert.ok(only);

		const entry = buildSettingEntry(only, undefined);

		assert.equal(entry.valueHidden, 'unaddressable');
		assert.equal(entry.presence, 'unknown');
	});

	it('reports a pre-JSON stored value as raw so a re-save is not called a no-op', () => {
		const entry = buildSettingEntry(row('flag'), { raw: 'bare-legacy-value', type: 'String' });

		assert.equal(entry.value?.display, 'bare-legacy-value');
		assert.equal(entry.value?.encoding, 'raw');
	});

	it('renders a structured value as JSON text', () => {
		const entry = buildSettingEntry(row('limits'), { raw: '{"retries":3}', type: 'String' });

		assert.equal(entry.value?.display, '{"retries":3}');
		assert.equal(entry.value?.masked, false);
	});
});

describe('buildLocalSettingEntry', () => {
	it('shows a plain local value', () => {
		const inventory = joinSettings({ blocks: [block('flag')], mode: 'local', live: ['shop-flag'] });
		const only = inventory.settings[0];
		assert.ok(only);

		const entry = buildLocalSettingEntry(only, true, 'on');

		assert.equal(entry.value?.display, 'on');
		assert.equal(entry.value?.masked, false);
	});

	/**
	 * A local secret is usually a random placeholder, which is harmless. But
	 * `db pull` seeds that same file from a real environment, so the one case
	 * that matters is exactly the one that would leak.
	 */
	it('masks a declared secret locally too', () => {
		const inventory = joinSettings({ blocks: [block('token', true)], mode: 'local', live: ['shop-token'] });
		const only = inventory.settings[0];
		assert.ok(only);

		const entry = buildLocalSettingEntry(only, true, 'pulled-from-production');

		assert.equal(entry.value?.display, REDACTED);
		assert.ok(!JSON.stringify(entry).includes('pulled-from-production'));
	});

	it('says the mock holds nothing for it yet', () => {
		const inventory = joinSettings({ blocks: [block('flag')], mode: 'local', live: [] });
		const only = inventory.settings[0];
		assert.ok(only);

		const entry = buildLocalSettingEntry(only, false, undefined);

		assert.equal(entry.valueHidden, 'not-present');
	});
});
