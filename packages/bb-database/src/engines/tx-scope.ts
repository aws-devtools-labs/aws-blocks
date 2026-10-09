// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tracks which engine transaction handle (if any) the current async context is
 * running inside. The shared PGlite cluster serializes work with a mutex, so a
 * `db.query()` issued from within a `db.transaction()` callback must join the
 * open transaction instead of waiting on the lock it already holds.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TransactionHandle } from '@aws-blocks/data-common';

const storage = new AsyncLocalStorage<TransactionHandle>();

/** Run `fn` with `handle` as the ambient transaction. */
export function runInTransactionScope<T>(handle: TransactionHandle, fn: () => Promise<T>): Promise<T> {
	return storage.run(handle, fn);
}

/** The ambient transaction handle, if the caller is inside a `transaction()` callback. */
export function currentTransactionHandle(): TransactionHandle | undefined {
	return storage.getStore();
}
