// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `auth.admin.scan`'s filter → Cognito `ListUsers` `Filter` (CodeQL: incomplete
 * string escaping). The value is quoted, so nothing in it may close the quote:
 * a `"` is refused (Cognito does not honour the documented `\"` escape: the
 * sandbox e2e saw it end the value), a backslash is refused (no documented
 * escape), and the attribute must be one Cognito can search on.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import {
	assertAdminUserFilter,
	encodeCognitoFilter,
	MAX_FILTER_LENGTH,
	SEARCHABLE_USER_ATTRIBUTES,
	toCognitoFilter,
} from './admin-filter.js';
import type { AdminUserFilter } from './types.js';

function refusal(filter: AdminUserFilter): { name?: string; status?: number } | null {
	try {
		toCognitoFilter(filter);
		return null;
	} catch (e) {
		const err = e as { name?: string; status?: number; statusCode?: number };
		return { name: err.name, status: err.status ?? err.statusCode };
	}
}

describe('toCognitoFilter', () => {
	test('quotes the value and uses ^= for startsWith, = for equals', () => {
		assert.strictEqual(
			toCognitoFilter({ attribute: 'email', match: 'startsWith', value: 'bob' }),
			'email ^= "bob"',
		);
		assert.strictEqual(toCognitoFilter({ attribute: 'username', match: 'equals', value: 'b1' }), 'username = "b1"');
	});

	test('refuses a double quote anywhere in the value: Cognito does not honour the escape', () => {
		for (const value of ['say "hi"', '" or username ^= "', 'u" or username ^= "', '"']) {
			assert.deepStrictEqual(
				refusal({ attribute: 'name', match: 'equals', value }),
				{ name: 'InvalidParameterException', status: 400 },
				JSON.stringify(value),
			);
		}
	});

	test('refuses a backslash anywhere in the value (no documented escape), including a trailing one', () => {
		for (const value of ['a\\b', 'trailing\\', '\\"', 'a\\\\"b']) {
			assert.deepStrictEqual(
				refusal({ attribute: 'username', match: 'equals', value }),
				{ name: 'InvalidParameterException', status: 400 },
				JSON.stringify(value),
			);
		}
	});

	test('refuses control characters in the value', () => {
		for (const value of ['a\nb', 'a\u0000', '\u007f']) {
			assert.strictEqual(
				refusal({ attribute: 'email', match: 'equals', value })?.name,
				'InvalidParameterException',
			);
		}
	});

	test('refuses an attribute Cognito cannot search on, so the name cannot inject an expression', () => {
		for (const attribute of [
			'username = "x" or email',
			'email ^=',
			'custom:department',
			'Email',
			'',
			'phone_number"',
		]) {
			assert.strictEqual(
				refusal({ attribute, match: 'equals', value: 'x' })?.name,
				'InvalidParameterException',
				attribute,
			);
		}
	});

	test('accepts every attribute the ListUsers reference lists as searchable', () => {
		for (const attribute of SEARCHABLE_USER_ATTRIBUTES) {
			assert.doesNotThrow(() => assertAdminUserFilter({ attribute, match: 'startsWith', value: 'x' }), attribute);
		}
	});

	test('refuses an unknown match and a non-string value from untyped callers', () => {
		const badMatch = { attribute: 'email', match: 'contains', value: 'x' } as unknown as AdminUserFilter;
		const badValue = { attribute: 'email', match: 'equals', value: 42 } as unknown as AdminUserFilter;
		assert.strictEqual(refusal(badMatch)?.name, 'InvalidParameterException');
		assert.strictEqual(refusal(badValue)?.name, 'InvalidParameterException');
	});

	test('pins the searchable list to the ListUsers reference, so a change to it is deliberate', () => {
		// https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_ListUsers.html
		// (`Filter`: "You can only search for the following standard attributes … Custom attributes aren't searchable.")
		assert.deepStrictEqual(
			[...SEARCHABLE_USER_ATTRIBUTES],
			[
				'username',
				'email',
				'phone_number',
				'name',
				'given_name',
				'family_name',
				'preferred_username',
				'cognito:user_status',
				'status',
				'sub',
			],
		);
	});

	test('refuses near-miss attribute names: case, whitespace, NUL, unsearchable standard ones, prototype keys', () => {
		for (const attribute of [
			'EMAIL',
			'Username',
			'Cognito:User_Status',
			'email ',
			' email',
			'email\u0000',
			'email\n',
			'email_verified',
			'phone_number_verified',
			'updated_at',
			'constructor',
			'__proto__',
			'toString',
		]) {
			assert.strictEqual(
				refusal({ attribute, match: 'equals', value: 'x' })?.name,
				'InvalidParameterException',
				JSON.stringify(attribute),
			);
		}
	});

	test('refuses non-string attribute / match / value shapes from untyped (JSON) callers', () => {
		const shapes: unknown[] = [
			{ attribute: ['email'], match: 'equals', value: 'x' }, // String(['email']) === 'email'
			{ attribute: 'email', match: ['equals'], value: 'x' },
			{ attribute: 'email', match: 'equals', value: ['a\\'] },
			{ attribute: 'email', match: 'equals', value: { toString: () => 'x' } },
			{ attribute: 'email', match: 'equals', value: null },
			{ attribute: 'email', match: 'equals' },
			{ attribute: 'email', value: 'x' },
			{},
		];
		for (const filter of shapes) {
			assert.strictEqual(
				refusal(filter as AdminUserFilter)?.name,
				'InvalidParameterException',
				JSON.stringify(filter),
			);
		}
	});

	test('Unicode look-alikes of quote / backslash are ordinary characters: passed through, never delimiters', () => {
		for (const value of ['“x”', '＂x', '＼', '\u2028', 'café', '\u{1f600}']) {
			assert.strictEqual(
				toCognitoFilter({ attribute: 'name', match: 'equals', value }),
				`name = "${value}"`,
				JSON.stringify(value),
			);
		}
	});

	test('for any accepted value, the expression has exactly two bare quotes and unescapes back to the value', () => {
		// Exhaustive over short strings of the characters that matter to the grammar.
		const alphabet = ['"', '\\', '^', '=', ' ', 'a'];
		const values: string[] = [''];
		for (let len = 1; len <= 4; len++) {
			for (const prefix of values.filter((v) => v.length === len - 1)) {
				for (const c of alphabet) values.push(prefix + c);
			}
		}
		let accepted = 0;
		for (const value of values) {
			let expr: string;
			try {
				expr = toCognitoFilter({ attribute: 'email', match: 'startsWith', value });
			} catch (e) {
				assert.ok(
					value.includes('\\') || value.includes('"'),
					`only backslash and quote values are refused: ${JSON.stringify(value)}`,
				);
				assert.strictEqual((e as { name?: string }).name, 'InvalidParameterException');
				continue;
			}
			accepted++;
			assert.ok(expr.startsWith('email ^= "') && expr.endsWith('"'), expr);
			const body = expr.slice('email ^= "'.length, -1);
			assert.strictEqual((expr.match(/"/g) ?? []).length, 2, expr);
			assert.strictEqual(body, value, expr);
		}
		assert.ok(accepted > 100);
	});

	test('reads each field once: a getter that changes its answer cannot smuggle an unchecked value', () => {
		const reads = { attribute: 0, match: 0, value: 0 };
		const changing = (field: keyof typeof reads, first: string, later: string) => () =>
			reads[field]++ === 0 ? first : later;
		const filter = Object.defineProperties(
			{},
			{
				attribute: { get: changing('attribute', 'email', 'email = "x" or username') },
				match: { get: changing('match', 'equals', 'startsWith') },
				value: { get: changing('value', 'safe', 'x\\" or username ^= "') },
			},
		) as AdminUserFilter;
		assert.strictEqual(toCognitoFilter(filter), 'email = "safe"');
		assert.deepStrictEqual(reads, { attribute: 1, match: 1, value: 1 });
	});

	test('assertAdminUserFilter returns a plain snapshot, detached from the caller object', () => {
		const input = { attribute: 'email', match: 'equals' as const, value: 'ok' };
		const checked = assertAdminUserFilter(input);
		input.value = 'x\\';
		assert.deepStrictEqual(checked, { attribute: 'email', match: 'equals', value: 'ok' });
	});

	test(`refuses an encoded filter longer than Cognito's ${MAX_FILTER_LENGTH} characters, counting the escapes`, () => {
		// `email = "` + value + `"` is 10 characters of overhead.
		const fits = 'a'.repeat(MAX_FILTER_LENGTH - 10);
		assert.strictEqual(
			toCognitoFilter({ attribute: 'email', match: 'equals', value: fits }).length,
			MAX_FILTER_LENGTH,
		);
		assert.strictEqual(
			refusal({ attribute: 'email', match: 'equals', value: `${fits}a` })?.name,
			'InvalidParameterException',
		);
	});

	test('the encoder escapes a backslash before a quote, even for a value validation would refuse', () => {
		// Defense in depth: validation refuses `\`, but the encoder alone must still keep the quote closed.
		assert.strictEqual(encodeCognitoFilter('email', 'equals', 'a\\'), 'email = "a\\\\"');
		assert.strictEqual(encodeCognitoFilter('email', 'equals', '\\"'), 'email = "\\\\\\""');
		assert.strictEqual(encodeCognitoFilter('email', 'startsWith', 'x"y'), 'email ^= "x\\"y"');
		for (const value of ['\\', '\\"', '"\\', 'a\\\\"b', '\\\\\\"']) {
			const inner = encodeCognitoFilter('email', 'equals', value).slice('email = "'.length, -1);
			// Every `"` inside the quoted value is preceded by an odd run of backslashes (it is escaped)…
			for (const m of inner.matchAll(/(\\*)"/g)) assert.strictEqual(m[1].length % 2, 1, inner);
			// …and the value does not end in a lone escape that would swallow the closing quote.
			assert.strictEqual((/\\*$/.exec(inner)?.[0].length ?? 0) % 2, 0, inner);
		}
	});
});
