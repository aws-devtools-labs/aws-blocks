// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The local PGlite serializes work with a mutex, so a db.query() inside a db.transaction() callback must
// join the open transaction instead of waiting on the lock it already holds.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TransactionHandle } from '@aws-blocks/data-common';

const storage = new AsyncLocalStorage<TransactionHandle>();

export function runInTransactionScope<T>(handle: TransactionHandle, fn: () => Promise<T>): Promise<T> {
	return storage.run(handle, fn);
}

export function currentTransactionHandle(): TransactionHandle | undefined {
	return storage.getStore();
}
