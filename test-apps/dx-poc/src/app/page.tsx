// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { countNotes, listNotes } from '@/lib/notes';
import { NoteForm, ToggleButton } from './note-form';

// The API URL is no longer a build-time unknown, because there is no separate API
// to call — but the page still reads the database per request.
export const dynamic = 'force-dynamic';

export default async function Home() {
	// A Server Component reading real Postgres in process. No wrapper method, no
	// RPC hop, no generated client.
	const [notes, total] = await Promise.all([listNotes(), countNotes()]);

	return (
		<main>
			<h1>Notes</h1>
			{/* data-* attribute rather than text: React interleaves a `<!-- -->`
			    separator between literal text and an expression, which makes rendered
			    text awkward to assert on. */}
			<p id="count" data-count={total}>
				{total} notes
			</p>
			<NoteForm />
			<ul id="notes">
				{notes.map((note) => (
					<li key={note.id} data-note-id={note.id}>
						<span data-done={note.done}>{note.text}</span>
						<ToggleButton id={note.id} done={note.done} />
					</li>
				))}
			</ul>
		</main>
	);
}
