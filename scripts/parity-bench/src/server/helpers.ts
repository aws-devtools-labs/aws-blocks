// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ProbeError, ProbeOutcome, ProbeRun } from '../core/types.js';

/** Wire-visible error shape plus the first `code` found down the `cause` chain (e.g. a driver's SQLSTATE). */
export function describeError(e: unknown): ProbeError {
	if (!(e instanceof Error)) return { name: typeof e };
	let causeCode: string | undefined;
	for (let c: unknown = e; c instanceof Error && causeCode === undefined; c = c.cause) {
		if ('code' in c && typeof c.code === 'string') causeCode = c.code;
	}
	const httpStatus = 'status' in e && typeof e.status === 'number' ? e.status : undefined;
	return {
		name: e.name,
		...(httpStatus === undefined ? {} : { httpStatus }),
		...(causeCode === undefined ? {} : { causeCode }),
	};
}

/** Run `act`, turning a throw into an `error` outcome. */
export async function observe(act: () => Promise<unknown>): Promise<ProbeOutcome> {
	try {
		return { status: 'ok', value: await act() };
	} catch (e) {
		return { status: 'error', error: describeError(e) };
	}
}

/**
 * The standard case shape: `setup` → `act` → `cleanup`, timed. A throwing setup
 * reports `setup-failed` (a harness problem, not a parity finding); a throwing
 * cleanup reports `cleanup: 'failed'`. Cleanup always runs.
 */
export async function runCase<S>(steps: {
	setup: () => Promise<S>;
	act: (state: S) => Promise<unknown>;
	cleanup?: (state: S | undefined) => Promise<void>;
}): Promise<ProbeRun> {
	const started = Date.now();
	let state: S | undefined;
	let outcome: ProbeOutcome;
	try {
		state = await steps.setup();
		outcome = await observe(() => steps.act(state as S));
	} catch (e) {
		outcome = { status: 'setup-failed', error: describeError(e) };
	}
	const durationMs = Date.now() - started;
	let cleanup: 'ok' | 'failed' = 'ok';
	try {
		await steps.cleanup?.(state);
	} catch {
		cleanup = 'failed';
	}
	return { outcome, durationMs, cleanup };
}

/** Narrow a case parameter, failing loudly when the catalog and the runner disagree. */
export function param<T extends 'string' | 'number' | 'boolean'>(
	params: Readonly<Record<string, unknown>>,
	key: string,
	type: T,
): T extends 'string' ? string : T extends 'number' ? number : boolean {
	const v = params[key];
	if (typeof v !== type) throw new Error(`parity case param "${key}" must be a ${type}`);
	return v as T extends 'string' ? string : T extends 'number' ? number : boolean;
}

/** Poll `check` until it returns a non-undefined value or `timeoutMs` elapses (then returns undefined). */
export async function pollFor<T>(check: () => Promise<T | undefined>, timeoutMs: number, intervalMs = 500): Promise<T | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await check();
		if (v !== undefined) return v;
		if (Date.now() >= deadline) return undefined;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}
