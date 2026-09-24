// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { BLOCKS_RPC_PREFIX, isRpcPath } from './constants.js';

// isRpcPath is the shared contract between the Lambda handler and the dev
// server for what counts as RPC. If they disagreed, a request would work in one
// and 404 in the other — the class of bug this predicate exists to prevent.
describe('isRpcPath', () => {
	test('matches the bare RPC path and everything in its subtree', () => {
		assert.strictEqual(isRpcPath(BLOCKS_RPC_PREFIX), true);
		assert.strictEqual(isRpcPath(`${BLOCKS_RPC_PREFIX}/notes`), true);
		assert.strictEqual(isRpcPath(`${BLOCKS_RPC_PREFIX}/a/b/c`), true);
	});

	test('does not match a sibling path that merely shares the prefix string', () => {
		// `/aws-blocks/apix` starts with the prefix as a string but is not under the
		// `/aws-blocks/api/` subtree, so it must not be treated as RPC.
		assert.strictEqual(isRpcPath(`${BLOCKS_RPC_PREFIX}x`), false);
	});

	test('does not match unrelated paths', () => {
		assert.strictEqual(isRpcPath('/health'), false);
		assert.strictEqual(isRpcPath('/aws-blocks/auth/callback'), false);
		assert.strictEqual(isRpcPath('/'), false);
	});
});
