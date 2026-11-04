// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { asyncDdlTarget, describeTarget, inSchema } from './async-ddl.js';
import { stripLiteralsAndComments } from './validation.js';

const target = (sql: string) => asyncDdlTarget(stripLiteralsAndComments(sql));

describe('asyncDdlTarget', () => {
	test('an index takes its table schema; inSchema fills in the block schema when the table is unqualified', () => {
		const unqualified = target('CREATE INDEX ASYNC t_n ON t (n)');
		assert.deepStrictEqual(unqualified, { kind: 'index', name: 't_n' });
		assert.ok(unqualified);
		assert.deepStrictEqual(inSchema(unqualified, 'app'), {
			kind: 'index',
			schema: 'app',
			name: 't_n',
		});
		assert.deepStrictEqual(
			target('create unique index async if not exists "Mixed" on only sales."Orders" (id) include (x)'),
			{ kind: 'index', schema: 'sales', name: 'Mixed' },
		);
	});

	test('a constraint validation names the table and the constraint, past comments and optional words', () => {
		assert.deepStrictEqual(
			target('-- validate\nALTER TABLE ASYNC IF EXISTS ONLY "S"."T" * VALIDATE CONSTRAINT c_x'),
			{ kind: 'constraint', schema: 'S', table: 'T', name: 'c_x' },
		);
		assert.deepStrictEqual(target('ALTER TABLE ASYNC t VALIDATE CONSTRAINT "a""b"'), {
			kind: 'constraint',
			table: 't',
			name: 'a"b',
		});
	});

	test('anything else is not an async target', () => {
		assert.strictEqual(target('CREATE INDEX t_n ON t (n)'), undefined);
		assert.strictEqual(target('ALTER TABLE t ADD CONSTRAINT c CHECK (n > 0) NOT VALID'), undefined);
		assert.strictEqual(target("SELECT 'CREATE INDEX ASYNC x ON t (n)'"), undefined);
	});

	test('describeTarget quotes every identifier', () => {
		assert.strictEqual(describeTarget({ kind: 'index', schema: 'app', name: 'Mixed' }), 'index "app"."Mixed"');
		assert.strictEqual(
			describeTarget({ kind: 'constraint', schema: 'app', table: 't', name: 'c' }),
			'constraint "c" on "app"."t"',
		);
	});
});
