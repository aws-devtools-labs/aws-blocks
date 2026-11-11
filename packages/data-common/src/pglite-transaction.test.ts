// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PgliteTransaction } from './pglite-transaction.js';

test('begin reports synchronous or asynchronous failures before the callback runs', async () => {
	const failure = new Error('BEGIN failed');
	await assert.rejects(
		() =>
			PgliteTransaction.begin(
				{},
				{
					transaction() {
						throw failure;
					},
				},
			),
		(error) => error === failure,
	);
	await assert.rejects(
		() =>
			PgliteTransaction.begin(
				{},
				{
					async transaction() {
						throw failure;
					},
				},
			),
		(error) => error === failure,
	);
});

test('commit waits for the database outcome and cleanup preserves the original failure', async () => {
	const failure = new Error('COMMIT failed');
	let commitStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		commitStarted = resolve;
	});
	let failCommit!: () => void;
	const finish = new Promise<void>((resolve) => {
		failCommit = resolve;
	});
	let rollbacks = 0;
	const handle = await PgliteTransaction.begin(
		{},
		{
			async transaction(callback) {
				await callback({
					async query() {
						return { rows: [] };
					},
					async rollback() {
						rollbacks++;
					},
				});
				commitStarted();
				await finish;
				throw failure;
			},
		},
	);
	let committed = false;
	const observed = assert.rejects(
		async () => {
			await handle.commit();
			committed = true;
		},
		(error) => error === failure,
	);
	await started;
	assert.equal(committed, false);
	await assert.rejects(() => handle.query('SELECT 1'), /closed/);
	failCommit();
	await observed;
	await handle.rollback();
	assert.equal(rollbacks, 0, 'cleanup must not issue a new ROLLBACK');
});

test('rollback failures are observed and a repeated cleanup does not retry on another session', async () => {
	const failure = new Error('ROLLBACK failed');
	let rollbacks = 0;
	const handle = await PgliteTransaction.begin(
		{},
		{
			async transaction(callback) {
				return callback({
					async query() {
						return { rows: [] };
					},
					async rollback() {
						rollbacks++;
						throw failure;
					},
				});
			},
		},
	);
	await assert.rejects(
		() => handle.rollback(),
		(error) => error === failure,
	);
	await handle.rollback();
	assert.equal(rollbacks, 1);
});
