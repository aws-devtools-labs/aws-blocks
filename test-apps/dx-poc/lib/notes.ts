// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import 'server-only';

import { data } from './backend';

// Every table and column name below is checked at compile time against the schema
// generated from ./migrations. Rename a column in a migration and these stop
// compiling — no raw SQL strings to grep, and no hand-written row types.
//
// For anything a builder shouldn't express — window functions, FILTER, extensions —
// the raw `sql` tag is still one import away and runs against the same database.

export function listNotes() {
	return data.from('notes').select('id', 'text', 'done').order('id', 'desc');
}

export function countNotes(): Promise<number> {
	return data.from('notes').select().count();
}

export function insertNote(text: string) {
	// Returns the stored row, including the generated id and created_at.
	return data.from('notes').insert({ text });
}

export async function setNoteDone(id: number, done: boolean): Promise<void> {
	// `.eq(...)` is required: an unfiltered update throws rather than rewriting
	// every row.
	await data.from('notes').update({ done }).eq('id', id);
}
