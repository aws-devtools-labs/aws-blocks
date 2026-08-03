// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Base for query builders that run when awaited.
 *
 * Implements the whole `Promise` surface, not just `then`. A `then`-only thenable
 * awaits correctly but is not a `Promise`, so `.catch(...)`, `.finally(...)` and any
 * API that expects a real promise (including `assert.rejects`) reject it — a footgun
 * that only shows up once someone reaches for one of those.
 *
 * Execution is memoized, so awaiting the same builder twice runs one query and yields
 * the same rows rather than silently hitting the database again.
 *
 * @module
 */

export abstract class ExecutableQuery<T> implements Promise<T> {
	private pending?: Promise<T>;

	/** Run the query. Called at most once per builder. */
	protected abstract execute(): Promise<T>;

	private run(): Promise<T> {
		this.pending ??= this.execute();
		return this.pending;
	}

	then<TResult1 = T, TResult2 = never>(
		onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		return this.run().then(onfulfilled, onrejected);
	}

	catch<TResult = never>(
		onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
	): Promise<T | TResult> {
		return this.run().catch(onrejected);
	}

	finally(onfinally?: (() => void) | null): Promise<T> {
		return this.run().finally(onfinally);
	}

	readonly [Symbol.toStringTag] = 'Promise';
}
