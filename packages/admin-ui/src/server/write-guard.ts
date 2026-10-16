// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The server-side unlock gate for cloud writes.
 *
 * Cloud writes are locked by default. This module is the SINGLE authority on
 * whether they are permitted: every write route asks it, and a locked write is
 * refused server-side with 403 rather than merely hidden in the UI. A greyed-out
 * button is an affordance, not a gate — anything that can reach the route must be
 * stopped at the route.
 *
 * **The window is absolute from the moment of unlock, and is never idle-extended.**
 * The reference implementation's doc comment promises "15 idle minutes" while its
 * code measures from a timestamp it never refreshes, so the two disagree and there
 * is no way to tell which was intended. We pick absolute deliberately: an idle
 * timeout that silently renews on every read never actually expires while a
 * dashboard tab sits open polling, which is precisely the situation the lock
 * exists to bound. Reading the state — `isUnlocked()`, `unlockState()`, any number
 * of times — therefore does NOT move the deadline.
 *
 * Expiry is evaluated lazily on read, so no timer is needed and a process that
 * sleeps clean through the window comes back locked instead of resuming with time
 * it did not spend.
 *
 * The state is a single module-level timestamp held in memory only, which means
 * restarting the process re-locks. That is a feature, not an oversight: a
 * redeploy or a crash-restart should never inherit an unlock nobody is watching.
 *
 * `now` is an injectable clock so expiry can be tested without a real sleep.
 */

/** Length of the unlock window. Absolute from the moment of unlock. */
export const UNLOCK_TTL_MS = 15 * 60 * 1000;

/** The gate's state as reported to callers, shaped to fill `UnlockResponse`. */
export interface UnlockState {
	unlocked: boolean;
	/** Full window length, so a UI can render a countdown without hardcoding it. */
	ttlMs: number;
	/** ISO timestamp the unlock lapses; absent while locked. */
	expiresAt?: string;
	/** Milliseconds left in the window; counts down, and is absent while locked. */
	expiresInMs?: number;
}

/**
 * The instant of the last unlock, or `undefined` while locked.
 *
 * Written only by `setUnlocked` and by lazy expiry. Never refreshed by a read —
 * see the absolute-window note above.
 */
let unlockedAt: number | undefined;

/**
 * Unlocks or re-locks cloud writes and reports the resulting state.
 *
 * Unlocking restarts the window from `now`, so unlocking again while already
 * unlocked extends the deadline to a full TTL from that new instant.
 * `setUnlocked(false)` re-locks immediately, with no grace period.
 */
export function setUnlocked(unlock: boolean, now?: number): UnlockState {
	const at = now ?? Date.now();
	unlockedAt = unlock ? at : undefined;
	return unlockState(at);
}

/**
 * Reports the current state, expiring a lapsed unlock as a side effect.
 *
 * The read is what notices expiry, but a read never postpones it.
 */
export function unlockState(now?: number): UnlockState {
	if (unlockedAt === undefined) {
		return { unlocked: false, ttlMs: UNLOCK_TTL_MS };
	}

	const expiresAtMs = unlockedAt + UNLOCK_TTL_MS;
	const expiresInMs = expiresAtMs - (now ?? Date.now());
	if (expiresInMs <= 0) {
		// Lapsed. Clear the timestamp so the state is locked from here on, which
		// is a collapse of an already-expired window, not a shortening of a live one.
		unlockedAt = undefined;
		return { unlocked: false, ttlMs: UNLOCK_TTL_MS };
	}

	return {
		unlocked: true,
		ttlMs: UNLOCK_TTL_MS,
		expiresAt: new Date(expiresAtMs).toISOString(),
		expiresInMs,
	};
}

/** The one question a write route asks before touching a cloud resource. */
export function isUnlocked(now?: number): boolean {
	return unlockState(now).unlocked;
}

/** Restores the locked initial state. Tests only — module state is process-wide. */
export function resetUnlockForTests(): void {
	unlockedAt = undefined;
}
