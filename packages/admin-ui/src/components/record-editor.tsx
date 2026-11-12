// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useMutation } from '@tanstack/react-query';
import { CircleAlert, Info, Pencil, Trash2 } from 'lucide-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { REDACTED_MARKER } from '@/components/json-view';
import { Badge } from '@/components/ui/badge';
import type { DataMode, DataRecord, RecordDeleteRequest, RecordWriteRequest, WriteMode, WriteResponse } from '@/contract/v1';
import { apiMutate, type ObservedRefusalCode, type ObservedWriteResponse } from '@/lib/api-mutate';

/**
 * Creating, editing and deleting one record.
 *
 * The server validates every write independently and refuses the ones it cannot
 * accept. Those refusals are the interesting part of this file: each one names a
 * next action the user can take, so they are rendered as instructions rather
 * than as failures. A refusal styled red teaches the user that the tool is
 * broken, when what the server actually said was "switch to edit".
 */

/** Widest the textarea grows before it scrolls instead. */
const MAX_ROWS = 26;
const MIN_ROWS = 8;

function recordsPath(fullId: string): string {
	return `/api/v1/data/${encodeURIComponent(fullId)}/records`;
}

// One wider than the contract's own union: `apiMutate` folds the locked-write
// 403 into this same shape, so the UI sees `LOCKED` alongside the rest.
type RefusalCode = ObservedRefusalCode;

/** Headline per refusal — phrased as the situation, never as an error code. */
const REFUSAL_TITLE: Record<RefusalCode, string> = {
	LOCKED: 'The unlock window has lapsed',
	LOCAL_SERVER_RUNNING: 'Stop the dev server first',
	ALREADY_EXISTS: 'That record already exists',
	NOT_FOUND: 'There is no such record yet',
	STORE_NOT_FOUND: 'That store is not there',
	UNSUPPORTED_STORE: 'This store cannot be written to',
	VALIDATION_FAILED: 'The server did not accept this record',
};

interface ValidationResult {
	ok: boolean;
	/** Named in a `role="alert"` region while Save is disabled. */
	reason?: string;
	item?: Record<string, unknown>;
}

/**
 * The client-side check. Runs on every keystroke so the reason a save is
 * unavailable is on screen before the user reaches for the button — but it is a
 * convenience only, and the UI says so: the server checks independently and its
 * answer is the one that counts.
 */
export function validateRecordDraft(text: string, keyFields: string[]): ValidationResult {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return { ok: false, reason: 'Nothing to save yet — a record is a JSON object.' };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		return { ok: false, reason: `Not valid JSON yet — ${error instanceof Error ? error.message : String(error)}` };
	}
	if (Array.isArray(parsed)) {
		return { ok: false, reason: 'This is a JSON array. One record is one JSON object, so save them one at a time.' };
	}
	if (typeof parsed !== 'object' || parsed === null) {
		const kind = parsed === null ? 'null' : typeof parsed;
		return { ok: false, reason: `This is ${kind}, not an object. A record is a JSON object with named fields.` };
	}
	const item = parsed as Record<string, unknown>;
	const missing = keyFields.filter((field) => {
		const value = item[field];
		return typeof value !== 'string' || value.trim().length === 0;
	});
	if (missing.length > 0) {
		const plural = missing.length !== 1;
		return {
			ok: false,
			reason: `Key field${plural ? 's' : ''} ${missing.join(', ')} ${
				plural ? 'each need' : 'needs'
			} to be a non-empty string — without ${plural ? 'them' : 'it'} the record cannot be addressed.`,
		};
	}
	return { ok: true, item };
}

/**
 * The starting text. For an edit that is the record as it stands; for a create
 * it is the key fields, present and empty, so the shape the store expects is
 * visible rather than something the user has to remember.
 */
export function seedDraft(writeMode: WriteMode, keyFields: string[], record?: DataRecord): string {
	if (writeMode === 'edit' && record !== undefined) {
		// `valueAsStored` when the reader transformed the value for display, so an
		// edit round-trips what is actually on disk. Seeding from `value` rewrote a
		// JSON-string field into an object the moment any edit was saved.
		return JSON.stringify(record.valueAsStored ?? record.value, null, 2);
	}
	const seed: Record<string, string> = {};
	for (const field of keyFields) seed[field] = '';
	return JSON.stringify(seed, null, 2);
}

/**
 * A refused write, rendered as guidance. Neutral surface and an informational
 * icon on purpose: the server is telling the user what to do next, and only a
 * transport failure earns the red treatment.
 */
function RefusalNotice({ response, action }: { response: ObservedWriteResponse; action?: ReactNode }) {
	const code = response.refusalCode;
	return (
		<div className="space-y-1.5 rounded-md border border-brand/25 bg-brand/5 px-3 py-2 text-xs">
			<div className="flex items-start gap-2">
				<Info size={13} strokeWidth={2.1} className="mt-px shrink-0 text-brand" aria-hidden="true" />
				<div className="space-y-1">
					<p className="font-medium text-fg">{code ? REFUSAL_TITLE[code] : 'The write was not applied'}</p>
					{code === 'LOCKED' && (
						<p className="text-fg-soft">
							The cloud-write unlock ran out before this save reached the server. Nothing was written. Unlock writes
							again above and re-save — the window is absolute, so a long edit can outlive it.
						</p>
					)}
					{code === 'LOCAL_SERVER_RUNNING' && (
						<p className="text-fg-soft">
							The local dev server holds this store in memory and would write its own copy back over this change, so
							the dashboard refused rather than lose the edit. Stop the dev server, save again, then start it back up.
						</p>
					)}
					{code === 'ALREADY_EXISTS' && (
						<p className="text-fg-soft">
							A record with this key is already in the store, and a create would overwrite it silently. Switch to
							editing it instead — you will get its current value to change.
						</p>
					)}
					{code === 'NOT_FOUND' && (
						<p className="text-fg-soft">
							There is nothing stored under this key to edit — it may have been deleted, or the key may have been
							changed in the editor. Switch to creating it instead.
						</p>
					)}
					{code === 'VALIDATION_FAILED' && (
						<p className="text-fg-soft">
							The server checked this record and turned it down. Its reason is below; the client-side check above is
							only a convenience and does not know every rule the store enforces.
						</p>
					)}
					{response.message && <p className="font-mono text-[11px] text-fg-dim">{response.message}</p>}
				</div>
			</div>
			{action && <div className="flex flex-wrap items-center gap-2 pl-[21px]">{action}</div>}
		</div>
	);
}

/** Buttons in the editor share one look; only the emphasis differs. */
const PRIMARY_BUTTON =
	'rounded-md bg-active px-2.5 py-1 text-xs font-medium text-fg transition-colors hover:bg-line disabled:cursor-not-allowed disabled:text-fg-dim disabled:hover:bg-active';
const QUIET_BUTTON =
	'rounded-md border border-line px-2.5 py-1 text-xs text-fg-soft transition-colors hover:bg-active hover:text-fg disabled:cursor-not-allowed disabled:text-fg-dim';

export interface RecordEditorProps {
	fullId: string;
	stage: string;
	mode: DataMode;
	store?: string;
	keyFields: string[];
	writeMode: WriteMode;
	/** The record being edited; absent for a create. */
	record?: DataRecord;
	/** Switch between create and edit, e.g. when the server says it is the other one. */
	onWriteModeChange: (next: WriteMode) => void;
	onClose: () => void;
	/** Re-read the records table — the write landed. */
	onSaved: () => void;
	/** A refusal carried `LOCKED`: the page re-reads the server's lock state. */
	onLockLapsed: () => void;
}

/** Create or edit one record as JSON. */
export function RecordEditor({
	fullId,
	stage,
	mode,
	store,
	keyFields,
	writeMode,
	record,
	onWriteModeChange,
	onClose,
	onSaved,
	onLockLapsed,
}: RecordEditorProps) {
	const [draft, setDraft] = useState(() => seedDraft(writeMode, keyFields, record));
	const alertId = useId();
	const validation = useMemo(() => validateRecordDraft(draft, keyFields), [draft, keyFields]);

	const mutation = useMutation({
		mutationFn: (item: Record<string, unknown>) =>
			apiMutate<ObservedWriteResponse>(recordsPath(fullId), 'POST', {
				stage,
				mode,
				store,
				writeMode,
				item,
			} satisfies RecordWriteRequest),
		onSuccess: (response) => {
			// The window may have lapsed mid-edit; the server is the authority on
			// that, so tell the page to go and ask it rather than guessing here.
			if (response.refusalCode === 'LOCKED') onLockLapsed();
			if (response.ok) onSaved();
		},
	});

	const response = mutation.data;
	const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, draft.split('\n').length + 1));
	// Editing a masked value would write the bullets back as literal text over
	// the real credential. The server never sent the original, so this cannot be
	// fixed here — it can only be said clearly.
	const editingMasked = writeMode === 'edit' && record?.redacted === true;

	const switchModeAction = (target: WriteMode) => (
		<button
			type="button"
			onClick={() => {
				onWriteModeChange(target);
				mutation.reset();
			}}
			className={PRIMARY_BUTTON}
		>
			{target === 'edit' ? 'Switch to editing this record' : 'Switch to creating it instead'}
		</button>
	);

	return (
		<div className="space-y-3 rounded-md border border-line bg-panel p-3">
			<div className="flex flex-wrap items-center gap-2">
				<Badge variant="outline">{writeMode === 'create' ? 'new record' : 'editing'}</Badge>
				<span className="text-xs text-fg-soft">
					{writeMode === 'create' ? (
						<>Creating a record in {mode === 'cloud' ? <>the deployed {stage} store</> : <>the local store</>}</>
					) : record ? (
						<>
							Editing <code className="font-mono text-[11px] text-fg">{record.key}</code> in{' '}
							{mode === 'cloud' ? <>the deployed {stage} store</> : <>the local store</>}
						</>
					) : (
						// Reached by switching a create into an edit after the server said
						// the record already exists: the draft is the address.
						<>
							Editing the record addressed by the key fields below, in{' '}
							{mode === 'cloud' ? <>the deployed {stage} store</> : <>the local store</>}
						</>
					)}
				</span>
				<button type="button" onClick={onClose} className={`${QUIET_BUTTON} ml-auto`}>
					Close
				</button>
			</div>

			{keyFields.length > 0 && (
				<p className="text-xs text-fg-dim">
					Key field{keyFields.length === 1 ? '' : 's'}{' '}
					{keyFields.map((field) => (
						<code key={field} className="mr-1 font-mono text-[11px] text-fg-soft">
							{field}
						</code>
					))}
					— {writeMode === 'create' ? 'these address the new record' : 'changing these addresses a different record'}.
				</p>
			)}

			{editingMasked && (
				<div className="flex items-start gap-2 rounded-md border border-warn/25 bg-warn/5 px-3 py-2 text-xs">
					<CircleAlert size={13} strokeWidth={2.1} className="mt-px shrink-0 text-warn-fg" aria-hidden="true" />
					<p className="text-fg-soft">
						This record had a credential-shaped value masked on the server, so the editor below shows{' '}
						<code className="font-mono text-[11px] text-warn-fg">{REDACTED_MARKER}</code> where the real value is.
						Saving as-is would store those bullets over the real value. Replace the marker with the value you want, or
						remove that field from the JSON to leave it out of the write.
					</p>
				</div>
			)}

			<textarea
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				rows={rows}
				spellCheck={false}
				aria-label={writeMode === 'create' ? 'New record as JSON' : `Record ${record?.key ?? ''} as JSON`}
				aria-invalid={!validation.ok}
				aria-describedby={alertId}
				className="w-full resize-y rounded-md border border-line bg-bg px-2.5 py-2 font-mono text-xs leading-relaxed text-fg outline-none focus:border-brand/50"
			/>

			{/* Empty when valid, so the alert fires on becoming invalid rather than
			    announcing a standing "all good" on every keystroke. */}
			<div id={alertId} role="alert" className="min-h-[1rem] text-xs">
				{!validation.ok && <span className="text-warn-fg">{validation.reason}</span>}
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					onClick={() => validation.item && mutation.mutate(validation.item)}
					disabled={!validation.ok || mutation.isPending}
					className={PRIMARY_BUTTON}
				>
					{mutation.isPending ? 'Saving…' : writeMode === 'create' ? 'Create record' : 'Save changes'}
				</button>
				<button
					type="button"
					onClick={() => setDraft(seedDraft(writeMode, keyFields, record))}
					disabled={mutation.isPending}
					className={QUIET_BUTTON}
				>
					Reset
				</button>
				<span className="text-xs text-fg-dim">
					Checked here as you type, and checked again by the server — the server's answer is the one that decides.
				</span>
			</div>

			{response && !response.ok && (
				<RefusalNotice
					response={response}
					action={
						response.refusalCode === 'ALREADY_EXISTS'
							? switchModeAction('edit')
							: response.refusalCode === 'NOT_FOUND'
								? switchModeAction('create')
								: undefined
					}
				/>
			)}

			{response?.ok && (
				<div className="flex items-start gap-2 rounded-md border border-ok/25 bg-ok/5 px-3 py-2 text-xs">
					<Badge variant="success">saved</Badge>
					<p className="text-fg-soft">
						{response.message || 'The record was written.'} The table below has been re-read from the store.
					</p>
				</div>
			)}

			{mutation.error && (
				<div className="rounded-md border border-danger/25 bg-danger/5 px-3 py-2 text-xs">
					<p className="text-fg-soft">
						The save could not be sent: {String(mutation.error)}. Nothing was written — this is the request failing, not
						the store refusing it.
					</p>
				</div>
			)}
		</div>
	);
}

export interface RecordDeleteButtonProps {
	fullId: string;
	stage: string;
	mode: DataMode;
	store?: string;
	record: DataRecord;
	/** Set when writes are gated; the control stays visible and says why. */
	disabledReason?: string;
	onDeleted: () => void;
	onLockLapsed: () => void;
}

/**
 * Per-row delete.
 *
 * Present only for a record that carries `keyValues`. Without them the record
 * cannot be addressed in a delete request, so no control is offered at all —
 * a button that can only fail is worse than the explanation it replaces.
 */
export function RecordDeleteButton({
	fullId,
	stage,
	mode,
	store,
	record,
	disabledReason,
	onDeleted,
	onLockLapsed,
}: RecordDeleteButtonProps) {
	const [confirming, setConfirming] = useState(false);
	const keyValues = record.keyValues;
	const addressable = keyValues !== undefined && Object.keys(keyValues).length > 0;

	const mutation = useMutation({
		mutationFn: (keys: Record<string, string>) =>
			apiMutate<ObservedWriteResponse>(recordsPath(fullId), 'DELETE', {
				stage,
				mode,
				store,
				keyValues: keys,
			} satisfies RecordDeleteRequest),
		onSuccess: (response) => {
			if (response.refusalCode === 'LOCKED') onLockLapsed();
			// "Already gone" is the outcome the user wanted, so refresh on it too.
			if (response.ok || response.refusalCode === 'NOT_FOUND') onDeleted();
			setConfirming(false);
		},
	});

	if (!addressable) {
		return (
			<span
				className="text-xs text-fg-dim"
				title="This store did not report the record's key attributes, so a delete cannot name which record to remove. Nothing to click here."
			>
				no key
			</span>
		);
	}

	const response = mutation.data;
	const alreadyGone = response?.refusalCode === 'NOT_FOUND';

	if (response && (response.ok || alreadyGone)) {
		return (
			<span className="text-xs text-fg-dim" title={response.message}>
				{alreadyGone ? 'already gone' : 'deleted'}
			</span>
		);
	}

	if (response && !response.ok) {
		return (
			<div className="min-w-[16rem] space-y-1.5">
				<RefusalNotice response={response} />
				<button type="button" onClick={() => mutation.reset()} className={QUIET_BUTTON}>
					Dismiss
				</button>
			</div>
		);
	}

	if (!confirming) {
		return (
			<button
				type="button"
				onClick={() => setConfirming(true)}
				disabled={disabledReason !== undefined}
				title={disabledReason ?? `Delete the record ${record.key}`}
				aria-label={`Delete record ${record.key}`}
				className="rounded-md border border-line p-1 text-fg-soft transition-colors hover:bg-active hover:text-danger-fg disabled:cursor-not-allowed disabled:border-line-soft disabled:text-fg-dim disabled:hover:bg-transparent disabled:hover:text-fg-dim"
			>
				<Trash2 size={12} strokeWidth={2} aria-hidden="true" />
			</button>
		);
	}

	return (
		<div className="min-w-[16rem] space-y-1.5 rounded-md border border-danger/30 bg-danger/5 px-2.5 py-2">
			<p className="text-xs text-fg-soft">
				Delete <code className="break-all font-mono text-[11px] text-fg">{record.key}</code>
				{mode === 'cloud' ? (
					<>
						{' '}
						from the deployed <span className="font-medium text-fg">{stage}</span> store? This changes real data and is
						not undone by re-locking.
					</>
				) : (
					<> from the local store on this machine?</>
				)}
			</p>
			<div className="flex flex-wrap items-center gap-1.5">
				<button
					type="button"
					onClick={() => mutation.mutate(keyValues)}
					disabled={mutation.isPending}
					className="rounded-md bg-danger/20 px-2 py-0.5 text-xs font-medium text-danger-fg-strong transition-colors hover:bg-danger/30 disabled:cursor-not-allowed disabled:opacity-60"
				>
					{mutation.isPending ? 'Deleting…' : 'Delete it'}
				</button>
				<button
					type="button"
					onClick={() => setConfirming(false)}
					disabled={mutation.isPending}
					className={QUIET_BUTTON}
				>
					Keep it
				</button>
			</div>
			{mutation.error && (
				<p className="text-xs text-fg-soft">
					The delete could not be sent: {String(mutation.error)}. Nothing was removed.
				</p>
			)}
		</div>
	);
}
