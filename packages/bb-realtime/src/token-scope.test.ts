// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Token scope isolation tests.
 *
 * Validates that connect tokens (scoped to the instance prefix) cannot be
 * used to authorize channel subscriptions. Channel tokens scoped to a specific
 * channel should still work as connect tokens since they already prove the
 * holder has access to something within the instance.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mintChannelToken, mintConnectToken, validateChannelToken } from './utils.js';

const SECRET = 'test-secret-key';
const INSTANCE_PREFIX = 'myapp-rt';
const CHANNEL = `${INSTANCE_PREFIX}/chat/room-1`;

describe('Token scope isolation: connect tokens cannot subscribe to channels', () => {
	it('channel token validates for its own channel', () => {
		const token = mintChannelToken(CHANNEL, SECRET);
		const result = validateChannelToken(token, SECRET, CHANNEL);
		assert.ok(result, 'channel token should validate for its specific channel');
		assert.strictEqual(result!.channel, CHANNEL);
	});

	it('connect token MUST NOT validate for a channel subscription', () => {
		const connectToken = mintConnectToken(INSTANCE_PREFIX, SECRET);
		// This is the critical assertion: a connect token should NOT authorize
		// subscription to a specific channel under the instance prefix.
		const result = validateChannelToken(connectToken, SECRET, CHANNEL);
		assert.strictEqual(result, null, 'connect token must NOT authorize channel subscriptions');
	});

	it('connect token should not validate for any sub-channel', () => {
		const connectToken = mintConnectToken(INSTANCE_PREFIX, SECRET);
		// Try several channels under the instance prefix
		const channels = [
			`${INSTANCE_PREFIX}/events/room-1`,
			`${INSTANCE_PREFIX}/notifications/user-123`,
			`${INSTANCE_PREFIX}/cursors/doc-456`,
		];
		for (const ch of channels) {
			const result = validateChannelToken(connectToken, SECRET, ch);
			assert.strictEqual(result, null, `connect token must NOT authorize ${ch}`);
		}
	});

	it('channel token works as a connect token (no requestedChannel)', () => {
		const channelToken = mintChannelToken(CHANNEL, SECRET);
		// When validating for connection (no requestedChannel), any valid token
		// from this instance should be accepted
		const result = validateChannelToken(channelToken, SECRET);
		assert.ok(result, 'channel token should be valid as a connect token');
	});

	it('new-style connect token validates without requestedChannel (connection use)', () => {
		const connectToken = mintConnectToken(INSTANCE_PREFIX, SECRET);
		// Connect tokens should still work for connection establishment
		const result = validateChannelToken(connectToken, SECRET);
		assert.ok(result, 'connect token should validate for connection establishment');
	});

	it('channel token for one channel cannot subscribe to a different channel', () => {
		const token = mintChannelToken(`${INSTANCE_PREFIX}/chat/room-1`, SECRET);
		const result = validateChannelToken(token, SECRET, `${INSTANCE_PREFIX}/chat/room-2`);
		assert.strictEqual(result, null, 'channel token for room-1 must NOT authorize room-2');
	});

	it('namespace-level token still works for sub-channels', () => {
		// A token scoped to a namespace (not the instance root) should still
		// authorize sub-channels within that namespace
		const nsToken = mintChannelToken(`${INSTANCE_PREFIX}/chat`, SECRET);
		const result = validateChannelToken(nsToken, SECRET, `${INSTANCE_PREFIX}/chat/room-1`);
		assert.ok(result, 'namespace token should authorize sub-channels');
	});
});
