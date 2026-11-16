// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { isBlocksError } from '@aws-blocks/core';
import { sql, type TransactionHandle } from '@aws-blocks/data-common/core';
import {
	DEFAULT_MAX_RETRIES,
	TRANSACTION_CONFLICT_BACKOFF_BASE_MS,
	TRANSACTION_CONFLICT_BACKOFF_CAP_MS,
} from '../constants.js';
import { DatabaseErrors, serializationConflict } from '../errors.js';
import { RecordingEngine } from '../test-support/recording-engine.js';
import { conflictRetryDelayMs, DatabaseCore } from './index.js';

// Any engine, not the local one, must see a block-level query inside a transaction() callback arrive on the
// in-transaction methods with that transaction's handle.
describe('DatabaseCore routes block-level statements into the open transaction', () => {
	test('query, queryOne and execute inside a transaction() callback run on the in-transaction methods with its handle, for any engine', async () => {
		const engine = new RecordingEngine();
		const core = new DatabaseCore({ engine: async () => engine });
		await core.transaction(async (tx) => {
			await tx.execute(sql`INSERT INTO t VALUES (1)`);
			await core.execute(sql`INSERT INTO t VALUES (2)`);
			await core.query(sql`SELECT 1`);
			await core.queryOne(sql`SELECT 2`);
		});
		const handle = engine.calls[0].handle;
		assert.ok(handle);
		const params: unknown[] = [];
		assert.deepStrictEqual(engine.calls, [
			{ method: 'begin', sql: 'BEGIN', params, handle },
			{ method: 'executeInTransaction', sql: 'INSERT INTO t VALUES (1)', params, handle },
			{ method: 'executeInTransaction', sql: 'INSERT INTO t VALUES (2)', params, handle },
			{ method: 'queryInTransaction', sql: 'SELECT 1', params, handle },
			{ method: 'queryInTransaction', sql: 'SELECT 2', params, handle },
			{ method: 'commit', sql: 'COMMIT', params, handle },
		]);
	});

	test('outside a callback, and from another core inside one, statements run auto-commit on their own engine', async () => {
		const a = new RecordingEngine();
		const b = new RecordingEngine();
		const coreA = new DatabaseCore({ engine: async () => a });
		const coreB = new DatabaseCore({ engine: async () => b });
		await coreA.transaction(async () => {
			await coreB.query(sql`SELECT 1`);
		});
		await coreA.query(sql`SELECT 2`);
		assert.deepStrictEqual(
			a.calls.map((c) => c.method),
			['begin', 'commit', 'query'],
		);
		assert.deepStrictEqual(b.calls, [{ method: 'query', sql: 'SELECT 1', params: [], handle: undefined }]);
	});

	test('a statement from a promise the callback did not await runs after the commit, not on the ended handle', async () => {
		const engine = new RecordingEngine();
		const core = new DatabaseCore({ engine: async () => engine });
		let late: Promise<unknown> = Promise.resolve();
		await core.transaction(async () => {
			late = new Promise((resolve) => setTimeout(resolve, 5)).then(() => core.query(sql`SELECT 1`));
		});
		await late;
		assert.deepStrictEqual(
			engine.calls.map((c) => c.method),
			['begin', 'commit', 'query'],
		);
	});
});

// The top of the range: `Math.random` returns less than 1.
const ALMOST_ONE = 1 - Number.EPSILON;

describe('conflictRetryDelayMs', () => {
	test('the ceiling doubles from the base with each retry and stops at the cap', () => {
		assert.strictEqual(TRANSACTION_CONFLICT_BACKOFF_BASE_MS, 50);
		assert.strictEqual(TRANSACTION_CONFLICT_BACKOFF_CAP_MS, 2000);
		const ceilings = Array.from({ length: 9 }, (_, retry) => conflictRetryDelayMs(retry, () => ALMOST_ONE));
		assert.deepStrictEqual(ceilings, [50, 100, 200, 400, 800, 1600, 2000, 2000, 2000]);
		assert.strictEqual(
			conflictRetryDelayMs(5000, () => ALMOST_ONE),
			2000,
			'a large retry number stays at the cap',
		);
	});

	test('the wait is a whole number spread over the range from 0 to the ceiling', () => {
		for (let retry = 0; retry < 9; retry++) {
			assert.strictEqual(
				conflictRetryDelayMs(retry, () => 0),
				0,
				'the bottom of the range is no wait',
			);
		}
		assert.strictEqual(
			conflictRetryDelayMs(0, () => 0.5),
			25,
		);
		assert.strictEqual(
			conflictRetryDelayMs(3, () => 0.5),
			200,
		);
		assert.strictEqual(
			conflictRetryDelayMs(7, () => 0.25),
			500,
		);
		for (const fraction of [0.01, 0.37, 0.5, 0.93, ALMOST_ONE]) {
			const delay = conflictRetryDelayMs(2, () => fraction);
			assert.ok(Number.isInteger(delay) && delay >= 0 && delay <= 200, `${delay} is in [0, 200]`);
		}
	});

	test('the default random source stays in the range', () => {
		for (let i = 0; i < 200; i++) {
			const delay = conflictRetryDelayMs(1);
			assert.ok(Number.isInteger(delay) && delay >= 0 && delay <= 100, `${delay} is in [0, 100]`);
		}
	});
});

/** Fails the first `conflicts` commits with `SerializationFailure`, as both engines report a conflict. */
class ConflictingEngine extends RecordingEngine {
	constructor(private conflicts: number) {
		super();
	}

	override async commitTransaction(handle: TransactionHandle): Promise<void> {
		await super.commitTransaction(handle);
		if (this.conflicts > 0) {
			this.conflicts--;
			throw serializationConflict(new Error('conflict'));
		}
	}
}

// The waits are recorded, not slept, so the suite asserts on what was asked for and never on the clock.
const retrying = (conflicts: number) => {
	const engine = new ConflictingEngine(conflicts);
	const waits: number[] = [];
	const core = new DatabaseCore({
		engine: async () => engine,
		sleep: async (ms) => {
			waits.push(ms);
		},
		random: () => ALMOST_ONE,
	});
	const counter = { attempts: 0 };
	const run = async () => {
		counter.attempts++;
	};
	return { core, waits, counter, run };
};

const isConflict = (e: unknown) => isBlocksError(e, DatabaseErrors.SerializationFailure);

describe('DatabaseCore.transaction() backs off between conflict retries', () => {
	test('the default is 8 retries: 8 conflicts commit on the ninth run, with a growing wait before each retry', async () => {
		assert.strictEqual(DEFAULT_MAX_RETRIES, 8);
		const { core, waits, counter, run } = retrying(8);
		await core.transaction(run, { retryOnConflict: true });
		assert.strictEqual(counter.attempts, 9);
		assert.deepStrictEqual(waits, [50, 100, 200, 400, 800, 1600, 2000, 2000]);
	});

	test('a ninth conflict is past the default and throws SerializationFailure', async () => {
		const { core, waits, counter, run } = retrying(9);
		await assert.rejects(core.transaction(run, { retryOnConflict: true }), isConflict);
		assert.strictEqual(counter.attempts, 9, 'the first run and 8 retries');
		assert.strictEqual(waits.length, 8, 'no wait after the last attempt');
	});

	test('maxRetries bounds the retries: N conflicts commit when N is at most maxRetries, N + 1 throw', async () => {
		const within = retrying(3);
		await within.core.transaction(within.run, { retryOnConflict: true, maxRetries: 3 });
		assert.strictEqual(within.counter.attempts, 4);
		assert.deepStrictEqual(within.waits, [50, 100, 200]);

		const beyond = retrying(4);
		await assert.rejects(beyond.core.transaction(beyond.run, { retryOnConflict: true, maxRetries: 3 }), isConflict);
		assert.strictEqual(beyond.counter.attempts, 4);
		assert.deepStrictEqual(beyond.waits, [50, 100, 200]);

		const none = retrying(1);
		await assert.rejects(none.core.transaction(none.run, { retryOnConflict: true, maxRetries: 0 }), isConflict);
		assert.strictEqual(none.counter.attempts, 1);
		assert.deepStrictEqual(none.waits, []);
	});

	test('without retryOnConflict a conflict is thrown at once, with no wait', async () => {
		const { core, waits, counter, run } = retrying(2);
		await assert.rejects(core.transaction(run), isConflict);
		await assert.rejects(core.transaction(run, { maxRetries: 5 }), isConflict);
		assert.strictEqual(counter.attempts, 2, 'one run per call');
		assert.deepStrictEqual(waits, []);
	});

	test('an error that is not a conflict is not retried', async () => {
		const { core, waits, counter } = retrying(0);
		await assert.rejects(
			core.transaction(
				async () => {
					counter.attempts++;
					throw new Error('driver text');
				},
				{ retryOnConflict: true },
			),
			(e: unknown) => isBlocksError(e, DatabaseErrors.TransactionFailed),
		);
		assert.strictEqual(counter.attempts, 1);
		assert.deepStrictEqual(waits, []);
	});

	test('a single auto-commit statement keeps its own fixed waits, apart from the transaction() wait', async () => {
		const engine = new RecordingEngine();
		const waits: number[] = [];
		const core = new DatabaseCore({
			engine: async () => engine,
			sleep: async (ms) => {
				waits.push(ms);
			},
		});
		engine.failOn.set('SELECT 1', serializationConflict(new Error('conflict')));
		await core.query(sql`SELECT 1`);
		assert.deepStrictEqual(
			engine.calls.map((c) => c.method),
			['query', 'query'],
			'the statement was retried',
		);
		assert.deepStrictEqual(waits, [], 'the transaction() wait is not on this path');
	});
});
