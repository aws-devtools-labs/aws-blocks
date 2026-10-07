// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { BLOCKS_RPC_PREFIX, isRpcPath, rpcNamespaceFromPath } from './constants.js';

describe('isRpcPath', () => {
	it('matches the bare RPC prefix and the whole per-namespace subtree', () => {
		assert.strictEqual(isRpcPath(BLOCKS_RPC_PREFIX), true);
		assert.strictEqual(isRpcPath(`${BLOCKS_RPC_PREFIX}/`), true);
		assert.strictEqual(isRpcPath(`${BLOCKS_RPC_PREFIX}/reports`), true);
		assert.strictEqual(isRpcPath(`${BLOCKS_RPC_PREFIX}/orders/items`), true);
	});

	it('does not match a sibling path that merely shares the prefix string', () => {
		// `/aws-blocks/apixyz` is neither the prefix nor under `${prefix}/`.
		assert.strictEqual(isRpcPath('/aws-blocks/apixyz'), false);
		assert.strictEqual(isRpcPath('/health'), false);
		assert.strictEqual(isRpcPath('/'), false);
	});
});

describe('rpcNamespaceFromPath', () => {
	it('returns the first segment after the prefix as the namespace', () => {
		assert.strictEqual(rpcNamespaceFromPath(`${BLOCKS_RPC_PREFIX}/reports`), 'reports');
	});

	it('returns only the first segment, ignoring any sub-path', () => {
		assert.strictEqual(rpcNamespaceFromPath(`${BLOCKS_RPC_PREFIX}/orders/items`), 'orders');
	});

	it('returns undefined for the bare prefix and the trailing-slash-only variant', () => {
		assert.strictEqual(rpcNamespaceFromPath(BLOCKS_RPC_PREFIX), undefined);
		assert.strictEqual(rpcNamespaceFromPath(`${BLOCKS_RPC_PREFIX}/`), undefined);
	});

	it('returns undefined for a path outside the RPC subtree', () => {
		assert.strictEqual(rpcNamespaceFromPath('/health'), undefined);
	});

	it('percent-decodes the segment, falling back to the raw value on malformed encoding', () => {
		assert.strictEqual(rpcNamespaceFromPath(`${BLOCKS_RPC_PREFIX}/a%2Db`), 'a-b');
		assert.strictEqual(rpcNamespaceFromPath(`${BLOCKS_RPC_PREFIX}/%ZZ`), '%ZZ');
	});
});
