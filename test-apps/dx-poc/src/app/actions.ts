// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
'use server';

import { revalidatePath } from 'next/cache';
import { insertNote, setNoteDone } from '@/lib/notes';

// Server Actions are the client→server boundary. Next.js supplies the endpoint,
// serialization, and types, so there is no hand-written RPC method here.
//
// A Server Action IS a public HTTP endpoint: anyone who can reach the site can
// invoke it. A real app gates each one with an auth block first
// (`await auth.requireAuth(context)`); this POC has no auth block yet, which is
// exactly why it validates input rather than trusting the caller.

export async function addNote(text: string) {
	const trimmed = text.trim();
	if (trimmed.length === 0) throw new Error('note text is required');
	if (trimmed.length > 500) throw new Error('note text is too long (max 500)');

	const note = await insertNote(trimmed);
	revalidatePath('/');
	return note;
}

export async function toggleNote(id: number, done: boolean) {
	if (!Number.isInteger(id)) throw new Error('id must be an integer');

	await setNoteDone(id, done);
	revalidatePath('/');
}
