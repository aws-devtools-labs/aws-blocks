// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { LOCAL_TOKEN_SECRET } from './local-dev.js';

describe('local-dev channel-token secret', () => {
	it('is high-entropy (32 random bytes, base64url)', () => {
		assert.match(LOCAL_TOKEN_SECRET, /^[A-Za-z0-9_-]{43}$/);
	});

	it('is one per process, even if the module is loaded twice (duplicate package copies)', async () => {
		const again: { LOCAL_TOKEN_SECRET: string } = await import(`./local-dev.js?copy=${Date.now()}`);
		assert.strictEqual(again.LOCAL_TOKEN_SECRET, LOCAL_TOKEN_SECRET);
	});
});
