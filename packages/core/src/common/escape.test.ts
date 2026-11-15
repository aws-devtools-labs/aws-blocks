// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeHtml, escapeRegExp } from '../bb-utils.js';

describe('escapeRegExp', () => {
	it('matches a dotted host literally', () => {
		const re = new RegExp(`^${escapeRegExp('example.com')}$`);
		assert.equal(re.test('example.com'), true);
		assert.equal(re.test('exampleXcom'), false);
	});

	it('neutralises alternation and groups', () => {
		const re = new RegExp(`^(?:${escapeRegExp('a)|(?:.*')})$`);
		assert.equal(re.test('anything'), false);
		assert.equal(re.test('a)|(?:.*'), true);
	});

	it('matches every metacharacter literally, with and without u/v, and inside a class', () => {
		const meta = '\\^$.*+?()[]{}|/-';
		for (const flags of ['', 'u', 'v']) {
			assert.equal(new RegExp(`^${escapeRegExp(meta)}$`, flags).test(meta), true, `flags=${flags}`);
		}
		for (const flags of ['', 'u']) {
			const cls = new RegExp(`^[${escapeRegExp(meta)}]+$`, flags);
			assert.equal(cls.test(meta), true, `class flags=${flags}`);
			assert.equal(cls.test('a'), false, `class flags=${flags}`);
		}
	});

	it('leaves text without metacharacters unchanged', () => {
		assert.equal(escapeRegExp('auth_app_1'), 'auth_app_1');
	});
});

describe('escapeHtml', () => {
	it('escapes markup and both quote styles', () => {
		assert.equal(
			escapeHtml(`<img src=x onerror="alert('1')">&\``),
			'&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;&#96;',
		);
	});

	it('converts non-strings with String()', () => {
		assert.equal(escapeHtml(42), '42');
		assert.equal(escapeHtml(null), 'null');
	});

	it('is not reversible into markup by a second pass', () => {
		assert.equal(escapeHtml(escapeHtml('<b>')), '&amp;lt;b&amp;gt;');
	});
});
