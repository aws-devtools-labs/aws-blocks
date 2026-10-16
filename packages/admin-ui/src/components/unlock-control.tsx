// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, ShieldAlert, Timer, Unlock } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import type { UnlockResponse } from '@/contract/v1';
import { apiGet } from '@/lib/api-client';
import { apiMutate } from '@/lib/api-mutate';

/**
 * The cloud-write lock.
 *
 * The lock is the server's, not this component's. A locked write is refused
 * with a 403 by the route itself, so nothing here can grant a write by getting
 * its own state wrong — the UI's job is to mirror the server accurately enough
 * that the user is never surprised, and to say plainly when it does not know.
 */

const UNLOCK_PATH = '/api/v1/writes/unlock';
const UNLOCK_QUERY_KEY = ['writes-unlock'] as const;
const TICK_MS = 1000;

/** What the page needs to gate its write controls, plus what the control renders. */
export interface CloudWriteLock {
	/** The server's last answer. `undefined` until the first read completes. */
	state: UnlockResponse | undefined;
	/** True only while the mirrored window still has time left in it. */
	unlocked: boolean;
	/** Milliseconds left, recomputed from the wall clock rather than counted down. */
	remainingMs: number;
	/** True while the first read is still in flight — neither locked nor unlocked. */
	loading: boolean;
	/** Set when the lock could not be read at all; writes stay unavailable. */
	error: unknown;
	/** Re-read the lock. Call after any refusal carrying `LOCKED`. */
	resync: () => void;
}

/**
 * Reads and tracks the server's cloud-write lock.
 *
 * Lives in a hook rather than inside the control because two callers need the
 * same single answer: the control renders it, and the page gates the editor and
 * the delete buttons on it. One query key means one fetch and one truth.
 *
 * Nothing is written to `localStorage` or `sessionStorage` — deliberately, and
 * unlike the stage selection and the session token, which do persist per tab. A
 * remembered unlock would let a reload present writes as available after the
 * server's window had already lapsed.
 */
export function useCloudWriteLock(enabled: boolean): CloudWriteLock {
	const query = useQuery({
		queryKey: UNLOCK_QUERY_KEY,
		queryFn: () => apiGet<UnlockResponse>(UNLOCK_PATH),
		enabled,
		// Always re-read on mount: a page reload must show the server's state,
		// not whatever this tab last saw. `gcTime: 0` drops the answer once the
		// last observer unmounts, so leaving cloud mode leaves nothing behind.
		refetchOnMount: 'always',
		staleTime: 0,
		gcTime: 0,
		retry: false,
	});

	const state = query.data;
	const refetch = query.refetch;
	/** When the server's answer landed — the origin the countdown measures from. */
	const anchor = query.dataUpdatedAt;

	const [now, setNow] = useState(() => Date.now());

	const unlockedAtAnchor = state?.unlocked === true;
	const windowMs = state?.expiresInMs ?? 0;

	// Derived from the wall clock against the moment the answer landed, never by
	// decrementing a stored counter. A backgrounded tab has its timers throttled
	// and a suspended laptop stops them altogether; both resume here with the
	// correct remaining time — or with zero, which triggers the resync below.
	//
	// Clamped to `windowMs` at the top as well as to zero at the bottom. Without
	// the upper bound the countdown could show MORE time than the server granted,
	// which is the one direction that matters: it promises a window the server
	// will refuse writes in. That happened for real — `now` is only advanced by
	// the tick below, so on the first paint after an unlock lands it was still the
	// mount time while `anchor` had jumped forward to the moment of the unlock,
	// making the elapsed term negative. A 15-minute window rendered as 15:22 on a
	// page that had been open 22 seconds. The re-anchor effect removes that skew;
	// this bound also covers the general case of a server clock ahead of ours.
	const remainingMs =
		unlockedAtAnchor && anchor > 0 ? Math.min(windowMs, Math.max(0, windowMs - (now - anchor))) : 0;

	// Re-anchor the clock whenever a new answer lands, so the first render after
	// an unlock measures from the same instant the server's window started rather
	// than from whenever this component happened to mount.
	useEffect(() => {
		setNow(Date.now());
	}, [anchor]);

	useEffect(() => {
		if (!unlockedAtAnchor) return;
		const timer = setInterval(() => setNow(Date.now()), TICK_MS);
		return () => clearInterval(timer);
	}, [unlockedAtAnchor, anchor]);

	// Zero is not a resting state. A client timer is not the authority on expiry,
	// so on reaching zero we ask the server instead of sitting on a stale zero —
	// which would otherwise be indistinguishable from "unlocked, 0 seconds left".
	// Guarded per anchor so one lapse causes one refetch, not a loop.
	const resyncedForAnchor = useRef(0);
	useEffect(() => {
		if (!unlockedAtAnchor || anchor === 0 || remainingMs > 0) return;
		if (resyncedForAnchor.current === anchor) return;
		resyncedForAnchor.current = anchor;
		void refetch();
	}, [unlockedAtAnchor, anchor, remainingMs, refetch]);

	const resync = useCallback(() => {
		void refetch();
	}, [refetch]);

	return {
		state,
		unlocked: unlockedAtAnchor && remainingMs > 0,
		remainingMs,
		loading: enabled && state === undefined && query.isFetching,
		error: query.error,
		resync,
	};
}

/** `m:ss`, the ticking digits. Read by eye; kept out of the live region. */
function formatCountdown(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The same span in words, for the copy that is not a clock. */
function describeRemaining(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	if (total >= 120) return `about ${Math.ceil(total / 60)} more minutes`;
	if (total >= 60) return 'about another minute';
	return `${total} more second${total === 1 ? '' : 's'}`;
}

/** The window length as the server reports it, rather than a hardcoded 15. */
function describeWindow(ttlMs: number): string {
	const minutes = Math.round(ttlMs / 60000);
	if (minutes >= 1) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
	return `${Math.round(ttlMs / 1000)} seconds`;
}

/**
 * What a screen reader hears. Bucketed deliberately: `aria-live` announces on
 * content change, so a per-second string would interrupt the user 900 times in
 * one window. This changes on state change and then at most once a minute.
 */
function announcementFor(known: boolean, unlocked: boolean, remainingMs: number): string {
	if (!known) return 'Checking with the server whether cloud writes are unlocked.';
	if (!unlocked) return 'Cloud writes are locked. Records in the cloud cannot be changed.';
	const total = Math.ceil(remainingMs / 1000);
	if (total > 60) return `Cloud writes are unlocked, about ${Math.ceil(total / 60)} minutes left.`;
	if (total > 30) return 'Cloud writes are unlocked, less than a minute left.';
	return 'Cloud writes lock again in a few seconds.';
}

/** Production-shaped stage names get the loudest treatment, as elsewhere on the page. */
function isProductionStage(stage: string): boolean {
	return /prod/i.test(stage);
}

export interface UnlockControlProps {
	stage: string;
	/** The shared lock, from `useCloudWriteLock`. */
	lock: CloudWriteLock;
}

/**
 * Renders the lock, and only ever in cloud mode — local writes are gated by the
 * session token but not by this window, so showing it there would invent a
 * restriction that does not exist.
 */
export function UnlockControl({ stage, lock }: UnlockControlProps) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const { state, unlocked, remainingMs } = lock;
	const production = isProductionStage(stage);

	const mutation = useMutation({
		mutationFn: (unlock: boolean) => apiMutate<UnlockResponse>(UNLOCK_PATH, 'POST', { unlock }),
		onSuccess: (next) => {
			// Writing the response into the cache re-stamps `dataUpdatedAt`, which
			// is the countdown's anchor, so the fresh window counts from now.
			queryClient.setQueryData(UNLOCK_QUERY_KEY, next);
			setConfirming(false);
		},
	});

	// A stage switch invalidates a half-finished confirmation: the blast radius
	// named in the prompt is no longer the stage the click would hit.
	useEffect(() => {
		setConfirming(false);
	}, [stage]);

	const announcement = announcementFor(state !== undefined, unlocked, remainingMs);
	const windowLabel = state ? describeWindow(state.ttlMs) : undefined;

	if (lock.error) {
		return (
			<div className="space-y-1.5 rounded-md border border-line bg-hover px-3 py-2 text-xs">
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant="outline">write lock unknown</Badge>
					<span className="text-fg-soft">
						The dashboard could not read the write lock from the server, so cloud writes stay unavailable here.
					</span>
				</div>
				<div className="flex items-center gap-2">
					<span className="text-fg-dim">The lock itself is server-side, so nothing is unlocked by this failing.</span>
					<button
						type="button"
						onClick={lock.resync}
						className="rounded-md border border-line px-2 py-0.5 text-fg-soft transition-colors hover:bg-active hover:text-fg"
					>
						Check again
					</button>
				</div>
			</div>
		);
	}

	return (
		<div
			className={`space-y-2 rounded-md border px-3 py-2.5 ${
				unlocked
					? production
						? 'border-danger/30 bg-danger/5'
						: 'border-warn/30 bg-warn/5'
					: 'border-line bg-hover'
			}`}
		>
			{/* The state in words, always — the countdown is a detail of it, not the signal itself. */}
			<div className="flex flex-wrap items-center gap-2 text-xs">
				{unlocked ? (
					<Badge variant={production ? 'destructive' : 'warning'}>
						<Unlock size={11} strokeWidth={2.2} className="mr-1" aria-hidden="true" />
						writes unlocked · {stage}
					</Badge>
				) : (
					<Badge variant="outline">
						<Lock size={11} strokeWidth={2.2} className="mr-1" aria-hidden="true" />
						writes locked · {stage}
					</Badge>
				)}
				{state === undefined ? (
					<span className="text-fg-soft">Reading the write lock from the server…</span>
				) : unlocked ? (
					<span className="text-fg-soft">
						Records in <span className="font-medium text-fg">{stage}</span> can be created, edited and deleted for{' '}
						{describeRemaining(remainingMs)}, then this locks itself again.
					</span>
				) : (
					<span className="text-fg-soft">
						Cloud records in <span className="font-medium text-fg">{stage}</span> are read-only until you unlock writes
						{windowLabel ? <> — an unlock lasts {windowLabel}</> : <> for the window the server sets</>} and covers this
						stage only.
					</span>
				)}
			</div>

			{unlocked && (
				<div className="flex flex-wrap items-center gap-3">
					{/* The digits tick every second, so they are hidden from the live
					    region; the polite region below carries coarse wording instead. */}
					<span className="flex items-center gap-1.5 font-mono text-sm tabular-nums text-fg" aria-hidden="true">
						<Timer size={13} strokeWidth={2} className="text-fg-dim" />
						{formatCountdown(remainingMs)}
					</span>
					<span className="text-xs text-fg-dim">left in this unlock</span>
					{state?.expiresAt && (
						<span className="text-xs text-fg-dim" title="The server's absolute expiry; the window is not extended by use.">
							lapses at {new Date(state.expiresAt).toLocaleTimeString()}
						</span>
					)}
					<button
						type="button"
						onClick={() => mutation.mutate(false)}
						disabled={mutation.isPending}
						className="rounded-md border border-line px-2.5 py-1 text-xs text-fg-soft transition-colors hover:bg-active hover:text-fg disabled:cursor-not-allowed disabled:text-fg-dim"
					>
						{mutation.isPending ? 'Re-locking…' : 'Re-lock now'}
					</button>
				</div>
			)}

			{/* A bar as well as the text, never instead of it. */}
			{unlocked && state && state.ttlMs > 0 && (
				<div className="h-0.5 w-full max-w-md overflow-hidden rounded-full bg-line" aria-hidden="true">
					<div
						className={production ? 'h-full bg-danger-fg/70' : 'h-full bg-warn-fg/70'}
						style={{ width: `${Math.max(0, Math.min(100, (remainingMs / state.ttlMs) * 100))}%` }}
					/>
				</div>
			)}

			{!unlocked && state !== undefined && !confirming && (
				<button
					type="button"
					onClick={() => setConfirming(true)}
					className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-fg-soft transition-colors hover:bg-active hover:text-fg"
				>
					<Unlock size={12} strokeWidth={2} aria-hidden="true" />
					Unlock writes
				</button>
			)}

			{/* A real confirm step, with the blast radius named in it. An unguarded
			    button is one stray click away from an edit to deployed data. */}
			{!unlocked && confirming && (
				<div
					className={`space-y-2 rounded-md border px-3 py-2 ${
						production ? 'border-danger/40 bg-danger/10' : 'border-warn/30 bg-warn/5'
					}`}
				>
					<div className="flex items-start gap-2 text-xs">
						<ShieldAlert
							size={14}
							strokeWidth={2}
							className={production ? 'mt-px shrink-0 text-danger-fg' : 'mt-px shrink-0 text-warn-fg'}
							aria-hidden="true"
						/>
						<p className="text-fg-soft">
							This unlocks writes against the deployed <span className="font-medium text-fg">{stage}</span> stack
							{production && (
								<>
									{' '}
									— a <span className="font-medium text-danger-fg">production-shaped stage name</span>
								</>
							)}
							. Creates, edits and deletes will change <span className="font-medium text-fg">real data</span> that
							whatever is running against {stage} reads, and they are not undone by re-locking
							{windowLabel ? <>. The unlock lapses on its own after {windowLabel}</> : ''}.
						</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<button
							type="button"
							onClick={() => mutation.mutate(true)}
							disabled={mutation.isPending}
							className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
								production
									? 'bg-danger/20 text-danger-fg-strong hover:bg-danger/30'
									: 'bg-warn/20 text-warn-fg-strong hover:bg-warn/30'
							}`}
						>
							{mutation.isPending ? 'Unlocking…' : `Yes, unlock writes to ${stage}`}
						</button>
						<button
							type="button"
							onClick={() => setConfirming(false)}
							disabled={mutation.isPending}
							className="rounded-md border border-line px-2.5 py-1 text-xs text-fg-soft transition-colors hover:bg-active hover:text-fg disabled:cursor-not-allowed"
						>
							Keep writes locked
						</button>
					</div>
				</div>
			)}

			{mutation.error && (
				<p className="text-xs text-fg-soft">
					The lock did not change: {String(mutation.error)}. The server still holds whatever state it had, so nothing was
					unlocked by this.
				</p>
			)}

			<span className="sr-only" aria-live="polite">
				{announcement}
			</span>
		</div>
	);
}
