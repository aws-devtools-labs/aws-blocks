// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
	BLOCKS_RPC_PREFIX,
	CLIENT_USER_AGENT_HEADER,
	canonicalBlocksPath,
	isRpcPath,
	rpcNamespaceFromPath,
} from './constants.js';

describe('canonicalBlocksPath', () => {
	it('maps the legacy /aws-blocks prefix to /cdk-blocks', () => {
		assert.strictEqual(canonicalBlocksPath('/aws-blocks'), '/cdk-blocks');
		assert.strictEqual(canonicalBlocksPath('/aws-blocks/api'), '/cdk-blocks/api');
		assert.strictEqual(canonicalBlocksPath('/aws-blocks/auth/callback'), '/cdk-blocks/auth/callback');
	});

	it('leaves canonical and unrelated paths alone', () => {
		assert.strictEqual(canonicalBlocksPath('/cdk-blocks/api'), '/cdk-blocks/api');
		assert.strictEqual(canonicalBlocksPath('/aws-blocksx/api'), '/aws-blocksx/api');
		assert.strictEqual(canonicalBlocksPath('/app/aws-blocks/api'), '/app/aws-blocks/api');
		assert.strictEqual(canonicalBlocksPath('/AWS-BLOCKS/api'), '/AWS-BLOCKS/api');
		assert.strictEqual(canonicalBlocksPath('/'), '/');
	});
});

describe('isRpcPath', () => {
	it('matches the legacy /aws-blocks/api subtree too', () => {
		assert.strictEqual(isRpcPath('/aws-blocks/api'), true);
		assert.strictEqual(isRpcPath('/aws-blocks/api/reports'), true);
		assert.strictEqual(isRpcPath('/aws-blocks/apixyz'), false);
	});

	it('matches the bare RPC prefix and the whole per-namespace subtree', () => {
		assert.strictEqual(isRpcPath(BLOCKS_RPC_PREFIX), true);
		assert.strictEqual(isRpcPath(`${BLOCKS_RPC_PREFIX}/`), true);
		assert.strictEqual(isRpcPath(`${BLOCKS_RPC_PREFIX}/reports`), true);
		assert.strictEqual(isRpcPath(`${BLOCKS_RPC_PREFIX}/orders/items`), true);
	});

	it('does not match a sibling path that merely shares the prefix string', () => {
		// `/cdk-blocks/apixyz` is neither the prefix nor under `${prefix}/`.
		assert.strictEqual(isRpcPath('/cdk-blocks/apixyz'), false);
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

	it('reads the namespace from a legacy /aws-blocks/api path', () => {
		assert.strictEqual(rpcNamespaceFromPath('/aws-blocks/api/reports'), 'reports');
	});

	it('returns undefined for a path outside the RPC subtree', () => {
		assert.strictEqual(rpcNamespaceFromPath('/health'), undefined);
	});

	it('percent-decodes the segment, falling back to the raw value on malformed encoding', () => {
		assert.strictEqual(rpcNamespaceFromPath(`${BLOCKS_RPC_PREFIX}/a%2Db`), 'a-b');
		assert.strictEqual(rpcNamespaceFromPath(`${BLOCKS_RPC_PREFIX}/%ZZ`), '%ZZ');
	});
});

describe('CLIENT_USER_AGENT_HEADER', () => {
	it('is the lowercase custom header name', () => {
		assert.strictEqual(CLIENT_USER_AGENT_HEADER, 'x-blocks-user-agent');
	});
});
