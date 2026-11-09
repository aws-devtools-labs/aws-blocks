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
import { createHmac } from 'node:crypto';
import { isBlocksError } from '@aws-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { Realtime, RealtimeErrors } from './index.js';
import { LOCAL_TOKEN_SECRET } from './local-dev.js';
import { isClientChannelPath, mintChannelToken, mintConnectToken, validateChannelName, validateChannelToken } from './utils.js';

const SECRET = 'test-secret-key';
const INSTANCE_PREFIX = 'myapp-rt';
const CHANNEL = `${INSTANCE_PREFIX}/chat/room-1`;
const anySchema: StandardSchemaV1<unknown> = {
	'~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
};

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

	it('instance name containing $connect does not create ambiguity', () => {
		// If an instance is literally named "foo$connect", its connect token
		// channel field is "foo$connect$connect". This must NOT authorize
		// channels under the instance like "foo$connect/cursors/room-1".
		const weirdPrefix = 'foo$connect';
		const connectToken = mintConnectToken(weirdPrefix, SECRET);
		const channel = `${weirdPrefix}/cursors/room-1`;
		const result = validateChannelToken(connectToken, SECRET, channel);
		assert.strictEqual(result, null, 'connect token for $connect-named instance must NOT authorize its channels');

		// But it still validates for connection establishment
		const connResult = validateChannelToken(connectToken, SECRET);
		assert.ok(connResult, 'connect token should still validate for connection');
	});

	it('connect token does not authorize channels under its own $connect scope', () => {
		const connectToken = mintConnectToken(INSTANCE_PREFIX, SECRET);
		for (const ch of [`${INSTANCE_PREFIX}$connect/chat/room-1`, `${INSTANCE_PREFIX}$connect/x`]) {
			assert.strictEqual(validateChannelToken(connectToken, SECRET, ch), null, `connect token must NOT authorize ${ch}`);
		}
	});
});

describe('isClientChannelPath', () => {
	it('accepts the <instance>/<namespace>/<channel> paths getChannel() mints', () => {
		for (const ch of [CHANNEL, `${INSTANCE_PREFIX}/chat/`, `${INSTANCE_PREFIX}/chat/a/b`, `${INSTANCE_PREFIX}/chat/${'x'.repeat(1024 - INSTANCE_PREFIX.length - 6)}`]) {
			assert.strictEqual(isClientChannelPath(ch), true, ch);
		}
	});

	it('rejects non-strings, empty and oversized paths, and paths without an instance and namespace', () => {
		for (const ch of [undefined, null, 42, {}, ['a/b/c'], '', 'room-1', `${INSTANCE_PREFIX}/chat`, '/chat/room-1', '__connection__', `${INSTANCE_PREFIX}/chat/${'x'.repeat(1024)}`]) {
			assert.strictEqual(isClientChannelPath(ch), false, JSON.stringify(ch)?.slice(0, 40));
		}
	});

	it('counts the limit in UTF-8 bytes', () => {
		const prefix = `${INSTANCE_PREFIX}/chat/`;
		const fits = prefix + 'é'.repeat((1024 - prefix.length) / 2);
		assert.strictEqual(isClientChannelPath(fits), true);
		assert.strictEqual(isClientChannelPath(fits + 'é'), false);
	});
});

describe('Channel token scope: exact vs subtree', () => {
	const TENANT = `${INSTANCE_PREFIX}/events/tenants/acme`;

	it('a token minted with scope "exact" for a is rejected for a/b', () => {
		const token = mintChannelToken(TENANT, SECRET, 3600, 'exact');
		assert.ok(validateChannelToken(token, SECRET, TENANT), 'exact token should validate for its own channel');
		assert.strictEqual(validateChannelToken(token, SECRET, `${TENANT}/billing`), null, 'exact token must NOT authorize a sub-channel');
		assert.strictEqual(validateChannelToken(token, SECRET, `${TENANT}-other`), null);
	});

	it('the default (subtree) token keeps authorizing sub-channels', () => {
		const token = mintChannelToken(TENANT, SECRET);
		assert.ok(validateChannelToken(token, SECRET, `${TENANT}/billing`), 'default token keeps today\'s subtree scope');
		assert.strictEqual(validateChannelToken(token, SECRET, `${TENANT}-other`), null, 'subtree scope is /-separated, not a string prefix');
	});

	it('the default token payload is byte-identical to the pre-scope format', () => {
		const token = mintChannelToken(TENANT, SECRET, 60);
		const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
		assert.deepStrictEqual(Object.keys(payload), ['channel', 'exp']);
	});

	it('a token without a scope field (issued before scope existed) still validates for sub-channels', () => {
		const payload = JSON.stringify({ channel: TENANT, exp: Math.floor(Date.now() / 1000) + 60 });
		const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
		const legacy = `${Buffer.from(payload).toString('base64url')}.${sig}`;
		assert.ok(validateChannelToken(legacy, SECRET, TENANT));
		assert.ok(validateChannelToken(legacy, SECRET, `${TENANT}/billing`));
	});

	function signed(payload: Record<string, unknown>): string {
		const json = JSON.stringify(payload);
		const sig = createHmac('sha256', SECRET).update(json).digest('base64url');
		return `${Buffer.from(json).toString('base64url')}.${sig}`;
	}
	const exp = () => Math.floor(Date.now() / 1000) + 60;

	it('a signed token with a scope field is rejected for subscriptions', () => {
		assert.strictEqual(validateChannelToken(signed({ channel: TENANT, exp: exp(), scope: 'everything' }), SECRET, TENANT), null);
		assert.strictEqual(validateChannelToken(signed({ channel: TENANT, exp: exp(), scope: 'exact' }), SECRET, `${TENANT}/billing`), null);
	});

	it('a signed token with both or neither of channel / exact is rejected', () => {
		assert.strictEqual(validateChannelToken(signed({ channel: TENANT, exact: TENANT, exp: exp() }), SECRET, TENANT), null);
		assert.strictEqual(validateChannelToken(signed({ exp: exp() }), SECRET, TENANT), null);
	});

	it('an exact token carries its path under "exact", not "channel"', () => {
		const token = mintChannelToken(TENANT, SECRET, 60, 'exact');
		const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
		assert.deepStrictEqual(Object.keys(payload), ['exact', 'exp']);
		assert.strictEqual(payload.exact, TENANT);
	});

	it('returns the normalized channel and scope', () => {
		assert.deepStrictEqual(
			{ ...validateChannelToken(mintChannelToken(TENANT, SECRET, 60, 'exact'), SECRET, TENANT), exp: 0 },
			{ channel: TENANT, exp: 0, scope: 'exact' },
		);
		assert.deepStrictEqual(
			{ ...validateChannelToken(mintChannelToken(TENANT, SECRET, 60), SECRET, `${TENANT}/billing`), exp: 0 },
			{ channel: TENANT, exp: 0, scope: 'subtree' },
		);
	});

	it('a validator from before scope existed refuses an exact token', () => {
		// The subscribe check from before `scope` existed, verbatim: HMAC over the
		// re-stringified payload, then a `channel` prefix match. It must not grant
		// an exact token anything, let alone subtree access.
		function preScopeValidate(token: string, secret: string, requestedChannel: string) {
			const [payloadB64, sig] = token.split('.');
			const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
			const expectedSig = createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url');
			if (sig !== expectedSig) return null;
			if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
			if (!payload.channel) return null;
			if (!payload.channel.includes('/')) return null;
			if (requestedChannel !== payload.channel && !requestedChannel.startsWith(payload.channel + '/')) return null;
			return payload;
		}
		const exact = mintChannelToken(TENANT, SECRET, 60, 'exact');
		assert.strictEqual(preScopeValidate(exact, SECRET, TENANT), null);
		assert.strictEqual(preScopeValidate(exact, SECRET, `${TENANT}/billing`), null);
		assert.ok(preScopeValidate(mintChannelToken(TENANT, SECRET, 60), SECRET, `${TENANT}/billing`), 'default tokens still work on old code');
	});
});

describe('getChannel() scope option (mock)', () => {
	const rt = new Realtime({ id: 'scope-test' }, 'rt', {
		namespaces: { events: Realtime.namespace(anySchema) },
	});

	async function tokenFor(channel: string, options?: { scope?: 'exact' | 'subtree' }) {
		const descriptor = (await rt.getChannel('events', channel, options)).toJSON();
		assert.strictEqual(typeof descriptor.token, 'string');
		return { channel: descriptor.channel, token: String(descriptor.token) };
	}

	it('{ scope: "exact" } mints a token that rejects sub-channels', async () => {
		const { channel, token } = await tokenFor('tenants/acme', { scope: 'exact' });
		assert.ok(validateChannelToken(token, LOCAL_TOKEN_SECRET, channel));
		assert.strictEqual(validateChannelToken(token, LOCAL_TOKEN_SECRET, `${channel}/billing`), null);
	});

	it('no options keeps the subtree scope', async () => {
		const { channel, token } = await tokenFor('tenants/acme');
		assert.ok(validateChannelToken(token, LOCAL_TOKEN_SECRET, `${channel}/billing`));
	});

	it('rejects an unknown scope value', async () => {
		await assert.rejects(
			() => rt.getChannel('events', 'room-1', { scope: 'all' as unknown as 'exact' }),
			(e: unknown) => isBlocksError(e, RealtimeErrors.ValidationFailed),
		);
	});
});

describe('Channel name grammar', () => {
	const rt = new Realtime({ id: 'grammar-test' }, 'rt', {
		namespaces: { events: Realtime.namespace(anySchema) },
	});
	const invalid = ['', '/a', 'a/', 'a//b', '/', '.', '..', 'a/../b', 'a/./b', '../a'];
	const valid = ['room-1', 'tenants/acme', 'tenants/acme/billing', 'a.b', '..a', 'user@example.com', 'a b'];

	it('validateChannelName rejects empty segments and . / .. segments', () => {
		for (const name of invalid) {
			assert.throws(() => validateChannelName(name), (e: unknown) => isBlocksError(e, RealtimeErrors.ValidationFailed), JSON.stringify(name));
		}
		for (const name of valid) validateChannelName(name);
	});

	it('validateChannelName rejects undefined, null and objects, and validates numbers as strings', () => {
		for (const name of [undefined, null, {}, [], true]) {
			assert.throws(() => validateChannelName(name as unknown as string), (e: unknown) => isBlocksError(e, RealtimeErrors.ValidationFailed), String(name));
		}
		validateChannelName(42 as unknown as string);
		validateChannelName(0 as unknown as string);
	});

	it('publish() checks the channel name before running the schema', async () => {
		let validated = 0;
		const counting: StandardSchemaV1<unknown> = {
			'~standard': { version: 1, vendor: 'test', validate: (value) => { validated++; return { value }; } },
		};
		const rt2 = new Realtime({ id: 'grammar-order-test' }, 'rt', { namespaces: { events: Realtime.namespace(counting) } });
		await assert.rejects(() => rt2.publish('events', 'a//b', {}), (e: unknown) => isBlocksError(e, RealtimeErrors.ValidationFailed));
		assert.strictEqual(validated, 0);
	});

	it('publish(), subscribe() and getChannel() reject invalid channel names', async () => {
		for (const name of invalid) {
			await assert.rejects(() => rt.publish('events', name, {}), (e: unknown) => isBlocksError(e, RealtimeErrors.ValidationFailed), `publish ${JSON.stringify(name)}`);
			assert.throws(() => rt.subscribe('events', name, () => {}), (e: unknown) => isBlocksError(e, RealtimeErrors.ValidationFailed), `subscribe ${JSON.stringify(name)}`);
			await assert.rejects(() => rt.getChannel('events', name), (e: unknown) => isBlocksError(e, RealtimeErrors.ValidationFailed), `getChannel ${JSON.stringify(name)}`);
		}
	});

	it('publish(), subscribe() and getChannel() accept valid channel names', async () => {
		for (const name of valid) {
			await rt.publish('events', name, {});
			rt.subscribe('events', name, () => {})();
			await rt.getChannel('events', name);
		}
	});
});
