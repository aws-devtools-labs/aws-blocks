// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The pg type parsers the DSQL engine installs must return the same JavaScript
 * values the local PGlite engine returns, so a handler's result types hold in
 * both environments.
 */
import assert from 'node:assert';
import { describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { dsqlTypeParsers, parseInt8 } from './dsql-engine.js';

describe('DSQL result types match the local engine', () => {
	test('bigint is a number when it is a safe integer and a BigInt otherwise, as PGlite returns it', async () => {
		const local = new PGlite();
		const row = (
			await local.query<{ small: unknown; big: unknown; negative: unknown; count: unknown }>(
				'SELECT 42::bigint AS small, 9007199254740993::bigint AS big, -7::bigint AS negative, count(*) AS count FROM (SELECT 1) t',
			)
		).rows[0];
		await local.close();
		const parse = dsqlTypeParsers.getTypeParser(20);
		assert.strictEqual(parse('42'), row.small);
		assert.strictEqual(parse('9007199254740993'), row.big);
		assert.strictEqual(parse('-7'), row.negative);
		assert.strictEqual(parse('1'), row.count);
		assert.strictEqual(typeof row.small, 'number');
		assert.strictEqual(typeof row.big, 'bigint');
		assert.strictEqual(parseInt8('9007199254740991'), Number.MAX_SAFE_INTEGER);
		assert.strictEqual(parseInt8('9007199254740992'), 9007199254740992n);
	});

	test('every other type keeps the pg default parser', () => {
		assert.strictEqual(dsqlTypeParsers.getTypeParser(23), pg.types.getTypeParser(23));
		assert.strictEqual(dsqlTypeParsers.getTypeParser(1700), pg.types.getTypeParser(1700));
		assert.strictEqual(dsqlTypeParsers.getTypeParser(20, 'binary'), pg.types.getTypeParser(20, 'binary'));
	});
});
