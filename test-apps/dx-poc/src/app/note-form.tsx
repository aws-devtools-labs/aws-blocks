// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
'use client';

import { useState, useTransition } from 'react';
import { addNote, toggleNote } from './actions';

// A Client Component. It imports the Server Actions, never `lib/backend` — that
// module is `server-only`, so importing it here would fail the build.
export function NoteForm() {
	const [text, setText] = useState('');
	const [pending, startTransition] = useTransition();

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				if (!text.trim()) return;
				startTransition(async () => {
					await addNote(text);
					setText('');
				});
			}}
		>
			<input
				id="note-input"
				value={text}
				onChange={(e) => setText(e.target.value)}
				placeholder="New note"
			/>
			<button type="submit" disabled={pending}>
				{pending ? 'Adding…' : 'Add note'}
			</button>
		</form>
	);
}

export function ToggleButton({ id, done }: { id: number; done: boolean }) {
	const [pending, startTransition] = useTransition();
	return (
		<button type="button" disabled={pending} onClick={() => startTransition(() => toggleNote(id, !done))}>
			{done ? 'Undo' : 'Done'}
		</button>
	);
}
