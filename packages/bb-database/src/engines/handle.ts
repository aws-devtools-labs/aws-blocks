// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import { foreignTransactionHandle, transactionEnded } from '../errors.js';

// The handle an engine's `beginTransaction()` returns. `settled` is set by the first of commitTransaction()
// and rollbackTransaction(), so the connection (or mutex) is freed exactly once and a later call sees it
// (DESIGN §4.3).
export abstract class EngineTransaction {
	settled = false;
}

/** The engine's own, still-open handle; anything else is refused with `TransactionFailed`. */
export function openTransaction<H extends EngineTransaction>(
	handle: TransactionHandle,
	ctor: abstract new (...args: never[]) => H,
	engineName: string,
): H {
	if (!(handle instanceof ctor)) throw foreignTransactionHandle(engineName);
	if (handle.settled) throw transactionEnded();
	return handle;
}

export function isSettled(handle: TransactionHandle): boolean {
	return handle instanceof EngineTransaction && handle.settled;
}

/**
 * BEGIN, `fn`, COMMIT; a `fn` that throws is rolled back. The COMMIT sits outside the rollback path: a failed
 * commit has settled the handle on both engines (DESIGN §4.3), so a rollback after it is a no-op on them and, on
 * an engine without that contract, would reach a connection its next borrower holds.
 */
export async function withTransaction<T>(
	engine: DatabaseEngine,
	fn: (handle: TransactionHandle) => Promise<T>,
): Promise<T> {
	const handle = await engine.beginTransaction();
	let result: T;
	try {
		result = await fn(handle);
	} catch (e) {
		await engine.rollbackTransaction(handle).catch(() => {});
		throw e;
	}
	await engine.commitTransaction(handle);
	return result;
}
