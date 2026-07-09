// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Security tests for token minting guards.
 * Validates that mintChannelToken and mintConnectToken refuse to sign tokens
 * when the secret is unavailable (empty, null, or undefined).
 *
 * These guards prevent leaking unsigned or weakly-signed tokens when SSM is
 * unreachable and the secret promise resolves to null.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mintChannelToken, mintConnectToken, validateChannelToken } from './utils.js';
import { RealtimeErrors } from './errors.js';

// ── Security: mintChannelToken secret guard ─────────────────────────────────

describe('Security: mintChannelToken secret guard', () => {
	it('throws ConnectionFailed when secret is empty string', () => {
		assert.throws(
			() => mintChannelToken('/ns/chat/room-1', ''),
			(err: Error) => {
				assert.strictEqual(err.name, RealtimeErrors.ConnectionFailed);
				assert.ok(err.message.includes('signing secret is empty or missing'));
				return true;
			},
		);
	});

	it('throws ConnectionFailed when secret is null (SSM unreachable)', () => {
		assert.throws(
			() => mintChannelToken('/ns/chat/room-1', null as unknown as string),
			(err: Error) => {
				assert.strictEqual(err.name, RealtimeErrors.ConnectionFailed);
				assert.ok(err.message.includes('signing secret is empty or missing'));
				return true;
			},
		);
	});

	it('throws ConnectionFailed when secret is undefined', () => {
		assert.throws(
			() => mintChannelToken('/ns/chat/room-1', undefined as unknown as string),
			(err: Error) => {
				assert.strictEqual(err.name, RealtimeErrors.ConnectionFailed);
				assert.ok(err.message.includes('signing secret is empty or missing'));
				return true;
			},
		);
	});

	it('succeeds with a valid secret', () => {
		const token = mintChannelToken('/ns/chat/room-1', 'valid-secret');
		assert.ok(token);
		assert.ok(token.includes('.'), 'token should have payload.signature format');
		const result = validateChannelToken(token, 'valid-secret');
		assert.ok(result);
		assert.strictEqual(result!.channel, '/ns/chat/room-1');
		assert.ok(result!.exp > Math.floor(Date.now() / 1000));
	});
});

// ── Security: mintConnectToken secret guard ─────────────────────────────────

describe('Security: mintConnectToken secret guard', () => {
	it('throws ConnectionFailed when secret is empty string', () => {
		assert.throws(
			() => mintConnectToken('test-app-rt', ''),
			(err: Error) => {
				assert.strictEqual(err.name, RealtimeErrors.ConnectionFailed);
				assert.ok(err.message.includes('signing secret is empty or missing'));
				return true;
			},
		);
	});

	it('throws ConnectionFailed when secret is null (SSM unreachable)', () => {
		assert.throws(
			() => mintConnectToken('test-app-rt', null as unknown as string),
			(err: Error) => {
				assert.strictEqual(err.name, RealtimeErrors.ConnectionFailed);
				assert.ok(err.message.includes('signing secret is empty or missing'));
				return true;
			},
		);
	});

	it('throws ConnectionFailed when secret is undefined', () => {
		assert.throws(
			() => mintConnectToken('test-app-rt', undefined as unknown as string),
			(err: Error) => {
				assert.strictEqual(err.name, RealtimeErrors.ConnectionFailed);
				assert.ok(err.message.includes('signing secret is empty or missing'));
				return true;
			},
		);
	});

	it('succeeds with a valid secret', () => {
		const token = mintConnectToken('test-app-rt', 'valid-secret');
		assert.ok(token);
		assert.ok(token.includes('.'), 'token should have payload.signature format');
		// connect token no longer authorizes sub-channels (scope isolation)
		const subResult = validateChannelToken(token, 'valid-secret', 'test-app-rt/events/room-1');
		assert.strictEqual(subResult, null, 'connect token must NOT authorize sub-channels');
		// but it still validates without a requestedChannel (for connection establishment)
		const connResult = validateChannelToken(token, 'valid-secret');
		assert.ok(connResult, 'connect token should validate for connection establishment');
	});
});

// ── Security: getChannel() secret unavailability simulation ─────────────────
// The AWS runtime's getChannel() calls:
//   const secret = await this._cachedSecretPromise; // resolves to null when SSM unreachable
//   mintChannelToken(fullChannel, secret);          // throws due to !secret guard
//   mintConnectToken(this.fullId, secret);          // throws due to !secret guard
//
// We test this exact scenario by passing null/empty as the secret.

describe('Security: getChannel() secret unavailability (AWS runtime simulation)', () => {
	it('mintChannelToken rejects null secret (simulates getChannel with SSM failure)', () => {
		const fullChannel = 'test-app-xfer/events/room-1';
		assert.throws(
			() => mintChannelToken(fullChannel, null as unknown as string),
			(err: Error) => {
				assert.strictEqual(err.name, RealtimeErrors.ConnectionFailed);
				return true;
			},
		);
	});

	it('mintConnectToken rejects null secret (simulates getChannel with SSM failure)', () => {
		assert.throws(
			() => mintConnectToken('test-app-xfer', null as unknown as string),
			(err: Error) => {
				assert.strictEqual(err.name, RealtimeErrors.ConnectionFailed);
				return true;
			},
		);
	});

	it('token minting succeeds when secret IS available (happy path)', () => {
		const fullChannel = 'test-app-xfer/events/room-1';
		const secret = 'ssm-provided-secret-value';

		const channelToken = mintChannelToken(fullChannel, secret);
		const connectToken = mintConnectToken('test-app-xfer', secret);

		assert.ok(channelToken, 'channel token should be minted');
		assert.ok(connectToken, 'connect token should be minted');

		// Validate both tokens work
		const chResult = validateChannelToken(channelToken, secret, fullChannel);
		assert.ok(chResult, 'channel token should validate');
		assert.strictEqual(chResult!.channel, fullChannel);

		// connect token no longer authorizes specific channels (scope isolation)
		const connResult = validateChannelToken(connectToken, secret, fullChannel);
		assert.strictEqual(connResult, null, 'connect token must NOT authorize specific channels');
		// but validates for connection (no requestedChannel)
		const connValidation = validateChannelToken(connectToken, secret);
		assert.ok(connValidation, 'connect token should validate for connection');
	});
});
