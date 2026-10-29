// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// A minimal app backend for the extractApiMethods test: one namespace, a helper in between.

import { KVStore } from '@aws-blocks/bb-kv-store';
import { ApiNamespace, Scope } from '@aws-blocks/core';

const scope = new Scope('fixture');
const store = new KVStore(scope, 'notes');

async function loadNote(key: string): Promise<string | null> {
	return store.get(key);
}

export const api = new ApiNamespace(scope, 'api', () => ({
	async save(key: string, text: string): Promise<void> {
		await store.put(key, text);
	},
	load: async (key: string) => loadNote(key),
	async ping(): Promise<string> {
		return 'pong';
	},
}));
