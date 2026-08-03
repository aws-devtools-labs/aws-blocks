// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import 'server-only';

/**
 * Compile-time tests for the fluent client's types.
 *
 * Nothing imports this — `npm run typecheck` is the assertion. Each
 * `@ts-expect-error` fails the build if the error it expects ever stops happening, so
 * these lines prove the schema types are load-bearing rather than decorative.
 *
 * Written the way a customer would write it: no casts (see AGENTS.md).
 */

import { data } from './backend';
import type { Notes } from './schema/database.types';

export async function typeChecks(): Promise<void> {
	// ── Table names are checked ────────────────────────────────────────────
	// @ts-expect-error 'nope' is not a table in the generated schema
	data.from('nope');

	// ── Column names are checked ──────────────────────────────────────────
	// @ts-expect-error 'title' is not a column on notes (it's 'text')
	await data.from('notes').select('title');

	// @ts-expect-error filters are checked against the same schema
	await data.from('notes').select('id').eq('titel', 'x');

	// @ts-expect-error so is order()
	await data.from('notes').select('id').order('nope');

	// ── Value types are checked against the column type ───────────────────
	// @ts-expect-error done is boolean, not string
	await data.from('notes').select('id').eq('done', 'yes');

	// @ts-expect-error id is number, not string
	await data.from('notes').select('id').eq('id', '1');

	// ── select() narrows the result ───────────────────────────────────────
	const partial = await data.from('notes').select('id', 'text');
	// @ts-expect-error 'done' was not selected, so it isn't on the result
	partial[0].done;

	// Selected columns are present and correctly typed.
	const text: string = partial[0].text;
	const id: number = partial[0].id;
	void text;
	void id;

	// No select() means the whole row.
	const full = await data.from('notes').select();
	const done: boolean = full[0].done;
	const createdAt: Date = full[0].created_at;
	void done;
	void createdAt;

	// ── Inserts reject database-managed columns ───────────────────────────
	// @ts-expect-error id is auto-generated; a caller must not choose it
	await data.from('notes').insert({ text: 'x', id: 1 });

	// @ts-expect-error created_at is auto-generated
	await data.from('notes').insert({ text: 'x', created_at: new Date() });

	// @ts-expect-error text is required
	await data.from('notes').insert({ done: true });

	// A minimal valid insert compiles and returns the full row.
	const inserted: Notes = await data.from('notes').insert({ text: 'valid' });
	void inserted;

	// ── Writes still type-check their filters ────────────────────────────
	// @ts-expect-error unknown column in an update filter
	await data.from('notes').update({ done: true }).eq('nope', 1);

	// @ts-expect-error cannot update an auto-generated column
	await data.from('notes').update({ id: 5 }).eq('id', 1);
}
