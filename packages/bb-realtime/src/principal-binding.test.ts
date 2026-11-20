// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for binding channel tokens to a principal, re-checking subscriptions
 * (`checkSubscriptionAuth`), and the matching behavior of the local WebSocket
 * server, which must treat tokens the way the deployed handler does.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { isBlocksError } from '@aws-cdk-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { attach, closeWebSocketServer } from './ws-server.js';
import { LOCAL_TOKEN_SECRET } from './local-dev.js';
import { Realtime, RealtimeErrors } from './index.js';
import { mintChannelToken, mintConnectToken, validateChannelToken, validatePrincipal, CONNECT_TOKEN_TTL_SECONDS } from './utils.js';
import { checkSubscriptionAuth, subscriptionEndedMessage, REVOCATION_RETENTION_SECONDS } from './subscription-auth.js';

const SECRET = 'principal-test-secret';
const CHANNEL = 'my-app-rt/chat/room-1';
const now = () => Math.floor(Date.now() / 1000);
const anySchema: StandardSchemaV1<unknown> = {
	'~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
};

function payloadOf(token: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
}

function signed(payload: Record<string, unknown>): string {
	const json = JSON.stringify(payload);
	return `${Buffer.from(json).toString('base64url')}.${createHmac('sha256', SECRET).update(json).digest('base64url')}`;
}

describe('mintChannelToken: principal, iat and jti', () => {
	it('signs the principal, issue time and a unique id into the payload', () => {
		const payload = payloadOf(mintChannelToken(CHANNEL, SECRET, 60, 'subtree', 'user-a'));
		assert.strictEqual(payload.sub, 'user-a');
		assert.strictEqual(payload.channel, CHANNEL);
		assert.ok(typeof payload.iat === 'number' && Math.abs(payload.iat - now()) <= 1);
		assert.strictEqual(payload.exp, (payload.iat as number) + 60);
		assert.ok(typeof payload.jti === 'string' && payload.jti.length >= 16);
	});

	it('leaves sub out when no principal is given', () => {
		assert.strictEqual('sub' in payloadOf(mintChannelToken(CHANNEL, SECRET)), false);
	});

	it('gives every token its own id', () => {
		assert.notStrictEqual(payloadOf(mintChannelToken(CHANNEL, SECRET)).jti, payloadOf(mintChannelToken(CHANNEL, SECRET)).jti);
	});

	it('binds a connect token to the principal too', () => {
		assert.strictEqual(payloadOf(mintConnectToken('my-app-rt', SECRET, undefined, 'user-a')).sub, 'user-a');
	});

	it('refuses an empty or oversized principal', () => {
		for (const principal of ['', 'x'.repeat(257)]) {
			assert.throws(() => mintChannelToken(CHANNEL, SECRET, 60, 'subtree', principal), (e: unknown) => isBlocksError(e, RealtimeErrors.ValidationFailed));
		}
		assert.doesNotThrow(() => validatePrincipal('x'.repeat(256)));
		assert.doesNotThrow(() => validatePrincipal(undefined));
		assert.throws(() => validatePrincipal(42), (e: unknown) => isBlocksError(e, RealtimeErrors.ValidationFailed));
	});
});

describe('validateChannelToken: principal binding', () => {
	it('returns the claims, including the principal', () => {
		const claims = validateChannelToken(mintChannelToken(CHANNEL, SECRET, 60, 'subtree', 'user-a'), SECRET, CHANNEL, { principal: 'user-a' });
		assert.strictEqual(claims?.sub, 'user-a');
		assert.ok(claims?.jti);
		assert.ok(claims?.iat);
	});

	it('refuses a token bound to a different principal', () => {
		const token = mintChannelToken(CHANNEL, SECRET, 60, 'subtree', 'user-a');
		assert.strictEqual(validateChannelToken(token, SECRET, CHANNEL, { principal: 'user-b' }), null);
	});

	it('refuses a bound token on a connection with no principal, and the reverse', () => {
		const bound = mintChannelToken(CHANNEL, SECRET, 60, 'subtree', 'user-a');
		const unbound = mintChannelToken(CHANNEL, SECRET, 60);
		assert.strictEqual(validateChannelToken(bound, SECRET, CHANNEL, { principal: undefined }), null);
		assert.strictEqual(validateChannelToken(unbound, SECRET, CHANNEL, { principal: 'user-a' }), null);
		assert.ok(validateChannelToken(unbound, SECRET, CHANNEL, { principal: undefined }));
	});

	it('binds exact tokens the same way', () => {
		const token = mintChannelToken(CHANNEL, SECRET, 60, 'exact', 'user-a');
		assert.ok(validateChannelToken(token, SECRET, CHANNEL, { principal: 'user-a' }));
		assert.strictEqual(validateChannelToken(token, SECRET, CHANNEL, { principal: 'user-b' }), null);
	});

	it('checks nothing about the principal when the caller does not ask', () => {
		assert.ok(validateChannelToken(mintChannelToken(CHANNEL, SECRET, 60, 'subtree', 'user-a'), SECRET, CHANNEL));
	});

	it('refuses a changed principal (the signature covers it)', () => {
		const token = mintChannelToken(CHANNEL, SECRET, 60, 'subtree', 'user-a');
		const altered = { ...payloadOf(token), sub: 'user-b' };
		const alteredToken = `${Buffer.from(JSON.stringify(altered)).toString('base64url')}.${token.split('.')[1]}`;
		assert.strictEqual(validateChannelToken(alteredToken, SECRET, CHANNEL, { principal: 'user-b' }), null);
	});

	it('refuses a signed token without iat, jti or a numeric exp, or with a malformed sub', () => {
		const base = { channel: CHANNEL, exp: now() + 60, iat: now(), jti: 'id' };
		assert.ok(validateChannelToken(signed(base), SECRET, CHANNEL));
		const { iat: _iat, ...noIat } = base;
		const { jti: _jti, ...noJti } = base;
		const { exp: _exp, ...noExp } = base;
		for (const payload of [noIat, noJti, noExp, { ...base, exp: String(base.exp) }, { ...base, jti: '' }, { ...base, sub: '' }, { ...base, sub: 7 }, { ...base, sub: 'x'.repeat(257) }]) {
			assert.strictEqual(validateChannelToken(signed(payload), SECRET, CHANNEL), null, JSON.stringify(payload));
		}
	});

	it('refuses an expired token', () => {
		assert.strictEqual(validateChannelToken(signed({ channel: CHANNEL, exp: now() - 1, iat: now() - 61, jti: 'id' }), SECRET, CHANNEL), null);
	});
});

describe('checkSubscriptionAuth', () => {
	const sub = { tokenExp: now() + 100, tokenIat: now() - 10, principal: 'user-a' };

	it('passes a live subscription', () => {
		assert.strictEqual(checkSubscriptionAuth(sub, 'user-a', undefined, now()), null);
	});

	it('ends it once the token has expired', () => {
		assert.strictEqual(checkSubscriptionAuth(sub, 'user-a', undefined, sub.tokenExp + 1), 'token_expired');
	});

	it("ends it when the principal differs from the connection's, including one side being absent", () => {
		assert.strictEqual(checkSubscriptionAuth(sub, 'user-b', undefined, now()), 'principal_mismatch');
		assert.strictEqual(checkSubscriptionAuth(sub, undefined, undefined, now()), 'principal_mismatch');
		assert.strictEqual(checkSubscriptionAuth({ ...sub, principal: undefined }, 'user-a', undefined, now()), 'principal_mismatch');
	});

	it('ends it when the token was issued at or before the revocation, not after', () => {
		assert.strictEqual(checkSubscriptionAuth(sub, 'user-a', sub.tokenIat, now()), 'access_revoked');
		assert.strictEqual(checkSubscriptionAuth(sub, 'user-a', sub.tokenIat + 5, now()), 'access_revoked');
		assert.strictEqual(checkSubscriptionAuth(sub, 'user-a', sub.tokenIat - 1, now()), null);
	});

	it('reports a revoked subscription as revoked even when its token has also expired', () => {
		const expired = { tokenExp: 100, tokenIat: 100, principal: 'u' };
		assert.strictEqual(checkSubscriptionAuth({ ...expired, tokenExp: 199 }, 'u', 200, 200), 'access_revoked');
		assert.strictEqual(checkSubscriptionAuth({ ...expired, tokenExp: 199 }, 'other', 200, 200), 'principal_mismatch');
		assert.strictEqual(checkSubscriptionAuth({ ...expired, tokenExp: 199, tokenIat: 250 }, 'u', 200, 200), 'token_expired');
	});

	it('keeps revocation records longer than any token can live', () => {
		assert.ok(REVOCATION_RETENTION_SECONDS > CONNECT_TOKEN_TTL_SECONDS);
	});

	it('words each failure for the client', () => {
		assert.match(subscriptionEndedMessage('token_expired'), /expired/);
		assert.match(subscriptionEndedMessage('principal_mismatch'), /does not match/);
		assert.match(subscriptionEndedMessage('access_revoked'), /revoked/);
	});
});

// ── Local WebSocket server ──────────────────────────────────────────────────

let httpServer: Server;
let port: number;

before(async () => {
	httpServer = createServer();
	attach(httpServer);
	await new Promise<void>((resolve) => httpServer.listen(0, resolve));
	port = (httpServer.address() as AddressInfo).port;
});

after(async () => {
	closeWebSocketServer();
	await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

/** Open a socket, optionally with a connect token, and collect everything the server sends. */
async function open(connectToken?: string) {
	const url = `ws://localhost:${port}/realtime${connectToken === undefined ? '' : `?token=${encodeURIComponent(connectToken)}`}`;
	const ws = new WebSocket(url);
	const received: Array<{ type: string; channel?: string; code?: string; message?: string }> = [];
	ws.on('message', (data) => received.push(JSON.parse(data.toString())));
	await new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	const next = async (count = 1) => {
		const deadline = Date.now() + 2000;
		while (received.length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
		return received.slice();
	};
	const send = (message: Record<string, unknown>) => ws.send(JSON.stringify(message));
	return { ws, received, next, send };
}

describe('local WebSocket server: principal binding', () => {
	it('subscribes a bound token on a connection opened with the same principal', async () => {
		const { ws, next, send } = await open(mintConnectToken('my-app-rt', LOCAL_TOKEN_SECRET, undefined, 'user-a'));
		send({ action: 'subscribe', channel: CHANNEL, token: mintChannelToken(CHANNEL, LOCAL_TOKEN_SECRET, 60, 'subtree', 'user-a') });
		assert.deepStrictEqual(await next(), [{ type: 'subscribe_success', channel: CHANNEL }]);
		ws.close();
	});

	it("refuses user-a's token on user-b's connection", async () => {
		const { ws, next, send } = await open(mintConnectToken('my-app-rt', LOCAL_TOKEN_SECRET, undefined, 'user-b'));
		send({ action: 'subscribe', channel: CHANNEL, token: mintChannelToken(CHANNEL, LOCAL_TOKEN_SECRET, 60, 'subtree', 'user-a') });
		assert.deepStrictEqual(await next(), [{ type: 'error', channel: CHANNEL, message: 'Unauthorized: invalid or expired token' }]);
		ws.close();
	});

	it('refuses a bound token on a connection with no connect token', async () => {
		const { ws, next, send } = await open();
		send({ action: 'subscribe', channel: CHANNEL, token: mintChannelToken(CHANNEL, LOCAL_TOKEN_SECRET, 60, 'subtree', 'user-a') });
		assert.strictEqual((await next())[0]?.type, 'error');
		ws.close();
	});

	it('rejects an upgrade whose connect token is invalid', async () => {
		const ws = new WebSocket(`ws://localhost:${port}/realtime?token=not.valid`);
		const outcome = await new Promise<string>((resolve) => {
			ws.on('open', () => resolve('open'));
			ws.on('error', () => resolve('refused'));
		});
		assert.strictEqual(outcome, 'refused');
	});

	it('rejects a subscribe to a path with a ".." segment', async () => {
		const { ws, next, send } = await open();
		send({ action: 'subscribe', channel: `${CHANNEL}/../room-2`, token: mintChannelToken(CHANNEL, LOCAL_TOKEN_SECRET) });
		assert.deepStrictEqual(await next(), [{ type: 'error', message: 'Invalid channel' }]);
		ws.close();
	});
});

describe('local WebSocket server: ping re-checks subscriptions', () => {
	it('ends a subscription whose token has expired', async () => {
		const { ws, next, send, received } = await open();
		send({ action: 'subscribe', channel: CHANNEL, token: mintChannelToken(CHANNEL, LOCAL_TOKEN_SECRET, 1) });
		await next();
		await new Promise((r) => setTimeout(r, 2100));
		send({ action: 'ping' });
		await next(2);
		assert.deepStrictEqual(received[1], { type: 'error', channel: CHANNEL, code: 'token_expired', message: 'Unauthorized: token expired' });
		ws.close();
	});

	it('keeps a subscription whose token is still valid', async () => {
		const { ws, next, send, received } = await open();
		send({ action: 'subscribe', channel: CHANNEL, token: mintChannelToken(CHANNEL, LOCAL_TOKEN_SECRET) });
		await next();
		send({ action: 'ping' });
		await new Promise((r) => setTimeout(r, 100));
		assert.strictEqual(received.length, 1);
		ws.close();
	});
});

describe('Realtime (mock): revokeAccess()', () => {
	const rt = new Realtime({ id: 'revoke-test' }, 'rt', { namespaces: { chat: Realtime.namespace(anySchema) } });

	it('ends a live subscription at once and tells the client', async () => {
		const handle = (await rt.getChannel('chat', 'live', { principal: 'rev-live' })).toJSON();
		const { ws, next, send, received } = await open(String(handle.connectToken));
		send({ action: 'subscribe', channel: handle.channel, token: handle.token });
		await next();
		await rt.revokeAccess('rev-live');
		await next(2);
		assert.deepStrictEqual(received[1], { type: 'error', channel: handle.channel, code: 'access_revoked', message: 'Unauthorized: access revoked' });
		ws.close();
	});

	it('refuses a new subscribe with a token minted before the revocation', async () => {
		const open1 = await open();
		const handle = (await rt.getChannel('chat', 'late')).toJSON();
		const other = (await rt.getChannel('chat', 'late', { principal: 'rev-late' })).toJSON();
		const { ws, next, send } = await open(String(other.connectToken));
		await rt.revokeAccess('rev-late');
		send({ action: 'subscribe', channel: other.channel, token: other.token });
		assert.deepStrictEqual(await next(), [{ type: 'error', channel: other.channel, code: 'access_revoked', message: 'Unauthorized: access revoked' }]);
		ws.close();
		// A handle with no principal is not affected by anyone's revocation.
		send2(open1, handle);
		assert.deepStrictEqual((await open1.next())[0], { type: 'subscribe_success', channel: handle.channel });
		open1.ws.close();
	});

	it('refuses an upgrade made with a connect token minted before the revocation', async () => {
		const handle = (await rt.getChannel('chat', 'upgrade', { principal: 'rev-upgrade' })).toJSON();
		await rt.revokeAccess('rev-upgrade');
		const ws = new WebSocket(`ws://localhost:${port}/realtime?token=${encodeURIComponent(String(handle.connectToken))}`);
		const outcome = await new Promise<string>((resolve) => {
			ws.on('open', () => resolve('open'));
			ws.on('error', () => resolve('refused'));
		});
		assert.strictEqual(outcome, 'refused');
	});

	it('accepts a handle minted after the revocation', async () => {
		await rt.revokeAccess('rev-after');
		await new Promise((r) => setTimeout(r, 1100));
		const handle = (await rt.getChannel('chat', 'after', { principal: 'rev-after' })).toJSON();
		const { ws, next, send } = await open(String(handle.connectToken));
		send({ action: 'subscribe', channel: handle.channel, token: handle.token });
		assert.deepStrictEqual(await next(), [{ type: 'subscribe_success', channel: handle.channel }]);
		ws.close();
	});

	it('rejects an invalid principal', async () => {
		await assert.rejects(() => rt.revokeAccess(''), (e: unknown) => isBlocksError(e, RealtimeErrors.ValidationFailed));
	});

	it('rejects an undefined principal', async () => {
		await assert.rejects(() => rt.revokeAccess(undefined as unknown as string), (e: unknown) => isBlocksError(e, RealtimeErrors.ValidationFailed));
	});

	it('rejects a getChannel() principal that is not a valid id', async () => {
		await assert.rejects(() => rt.getChannel('chat', 'bad', { principal: '' }), (e: unknown) => isBlocksError(e, RealtimeErrors.ValidationFailed));
	});
});

function send2(client: Awaited<ReturnType<typeof open>>, handle: { channel: string; token?: unknown }) {
	client.send({ action: 'subscribe', channel: handle.channel, token: handle.token });
}
