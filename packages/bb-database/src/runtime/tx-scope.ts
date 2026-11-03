// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The transaction a transaction() callback runs in, so a block-level statement inside the callback can
// join it (core/index.ts) and a sibling block on the same local cluster can nest in it (pglite-cluster.ts).
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TransactionHandle } from '@aws-blocks/data-common';

export class TransactionScope {
	/** Cleared once the transaction has committed or rolled back. */
	open = true;

	constructor(
		/** The DatabaseCore that opened the transaction; only its own statements join. */
		readonly owner: object,
		readonly handle: TransactionHandle,
	) {}
}

const storage = new AsyncLocalStorage<TransactionScope>();

export function runInTransactionScope<T>(scope: TransactionScope, fn: () => Promise<T>): Promise<T> {
	return storage.run(scope, fn);
}

export function currentTransactionScope(): TransactionScope | undefined {
	const scope = storage.getStore();
	return scope?.open ? scope : undefined;
}

export function currentTransactionHandle(): TransactionHandle | undefined {
	return currentTransactionScope()?.handle;
}
