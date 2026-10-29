// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the per-case block-method tracker.

import { test } from 'node:test';
import assert from 'node:assert';
import { runCase } from '../src/server/helpers.js';
import { trackBlock, traceCase } from '../src/server/track.js';

class FakeStore {
	readonly bbName = 'KVStore';
	#items = new Map<string, string>();
	async put(key: string, value: string): Promise<void> {
		this.#items.set(key, value);
	}
	async get(key: string): Promise<string | null> {
		return this.#items.get(key) ?? null;
	}
	async delete(key: string): Promise<void> {
		this.#items.delete(key);
	}
}

test('a case reports only the methods its act step called', async () => {
	const store = trackBlock(new FakeStore());
	const { result, methods } = await traceCase(() =>
		runCase({
			setup: async () => store.put('k', 'v'),
			act: async () => store.get('k'),
			cleanup: async () => store.delete('k'),
		}),
	);
	assert.deepStrictEqual(methods, ['KVStore.get']);
	// Private fields still work: the method ran on the real instance.
	assert.deepStrictEqual(result.outcome, { status: 'ok', value: 'v' });
});

test('a runner without runCase reports every method it called', async () => {
	const store = trackBlock(new FakeStore());
	const { methods } = await traceCase(async () => {
		await store.put('k', 'v');
		return store.get('k');
	});
	assert.deepStrictEqual(methods, ['KVStore.get', 'KVStore.put']);
});

test('calls outside a traced case are not recorded, and concurrent cases stay separate', async () => {
	const store = trackBlock(new FakeStore());
	await store.put('outside', 'x');
	const [a, b] = await Promise.all([
		traceCase(async () => store.get('outside')),
		traceCase(async () => store.delete('outside')),
	]);
	assert.deepStrictEqual(a.methods, ['KVStore.get']);
	assert.deepStrictEqual(b.methods, ['KVStore.delete']);
});
