// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { setTimeout } from 'node:timers/promises';
import type { api as apiType } from 'aws-blocks';

type Cursor = Parameters<typeof apiType.realtimePublishCursor>[0];

export function realtimeTests(getApi: () => typeof apiType) {

	describe('Realtime', { timeout: 60_000 }, () => {

		describe('Publish & Subscribe', () => {
			test('server publish reaches subscriber via channel handle', async () => {
				const api = getApi();
				const cursor: Cursor = { userId: 'u1', x: 42, y: 99, color: 'red' };

				const channel = await api.realtimeGetCursorChannel();

				assert.ok(typeof channel.subscribe === 'function', 'Hydrated channel should have subscribe()');

				const received = new Promise<Cursor>((resolve, reject) => {
					const timer = globalThis.setTimeout(() => reject(new Error('Realtime message not received within 10s')), 10000);
					const sub = channel.subscribe((msg) => {
						clearTimeout(timer);
						sub.unsubscribe();
						resolve(msg);
					});
					// Wait for the WebSocket subscription to be established before publishing
					sub.established.then(() => {
						return api.realtimePublishCursor(cursor);
					}).catch(reject);
				});

				const msg = await received;
				assert.deepStrictEqual(msg, cursor);
			});

			test('server-side subscribe receives messages from separate Lambda invocation', async () => {
				const api = getApi();
				const cursor: Cursor = { userId: 'u1', x: 10, y: 20, color: 'purple' };
				// Start server-side subscribe (Lambda A) — blocks waiting for a message
				const msgPromise = api.realtimeServerSubscribeAndWait('server-sub-cross');
				// Give the subscribe time to establish the WebSocket, then publish
				// with retries to handle cold-start races
				for (let i = 0; i < 5; i++) {
					await setTimeout(2000);
					await api.realtimePublishToChannel('server-sub-cross', cursor);
				}
				// Lambda A should receive the message via WebSocket
				const msg = await msgPromise;
				assert.deepStrictEqual(msg, cursor);
			});
		});

		describe('Channel Scoping', () => {
			test('multiple channels share a connection and receive their own messages with no cross-contamination', async () => {
				const api = getApi();
				const cursor1: Cursor = { userId: 'u1', x: 1, y: 2, color: 'blue' };
				const cursor2: Cursor = { userId: 'u2', x: 3, y: 4, color: 'green' };

				const ch1 = await api.realtimeGetChannel('room-1');
				const ch2 = await api.realtimeGetChannel('room-2');

				const ch1Msgs: Cursor[] = [];
				const ch2Msgs: Cursor[] = [];

				const sub1 = ch1.subscribe((msg) => ch1Msgs.push(msg));
				const sub2 = ch2.subscribe((msg) => ch2Msgs.push(msg));

				await sub1.established;
				await sub2.established;

				// Both subscriptions should share the same underlying WebSocket
				assert.ok(sub1.connection, 'sub1 should expose the underlying connection');
				assert.strictEqual(sub1.connection, sub2.connection, 'Both channels should share a single WebSocket connection');

				// Publish to room-1, verify only room-1 gets it
				await api.realtimePublishToChannel('room-1', cursor1);
				await setTimeout(1000);

				assert.strictEqual(ch1Msgs.length, 1, 'room-1 should receive its message');
				assert.strictEqual(ch2Msgs.length, 0, 'room-2 should NOT receive room-1 message');
				assert.deepStrictEqual(ch1Msgs[0], cursor1);

				// Publish to room-2, verify only room-2 gets it
				await api.realtimePublishToChannel('room-2', cursor2);
				await setTimeout(1000);

				assert.strictEqual(ch1Msgs.length, 1, 'room-1 should still have only its message');
				assert.strictEqual(ch2Msgs.length, 1, 'room-2 should receive its message');
				assert.deepStrictEqual(ch2Msgs[0], cursor2);

				sub1.unsubscribe();
				sub2.unsubscribe();
			});
		});

		describe('Token Scope Isolation', () => {
			test('connect token cannot be reused as a channel subscription token', async () => {
				const api = getApi();

				// Get raw descriptors to extract tokens and channel paths
				// realtimeGetRawDescriptor strips __blocks so middleware won't hydrate them
				const publicDescriptor = await api.realtimeGetRawDescriptor('public-room') as unknown as { connectToken: string; wsUrl: string; token: string; channel: string };
				const privateDescriptor = await api.realtimeGetRawDescriptor('private-room') as unknown as { channel: string; token: string };

				const { connectToken, wsUrl } = publicDescriptor;
				const { channel: privateChannel } = privateDescriptor;

				assert.ok(connectToken, 'Descriptor should include a connectToken');
				assert.ok(wsUrl, 'Descriptor should include a wsUrl');
				assert.ok(privateChannel, 'Private descriptor should include a channel path');

				// Open a raw WebSocket using the connect token for connection auth
				const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(connectToken)}`);

				const reply = await new Promise<{ type: string; channel?: string; message?: string }>((resolve, reject) => {
					const timer = globalThis.setTimeout(() => {
						ws.close();
						reject(new Error('No reply from server within 5s'));
					}, 5000);

					ws.onopen = () => {
						// Attempt to subscribe using the connect token AS the channel token.
						// This should be rejected — connect tokens are scoped to the instance
						// prefix ($connect) and must not authorize channel subscriptions.
						ws.send(JSON.stringify({
							action: 'subscribe',
							channel: privateChannel,
							token: connectToken,
						}));
					};

					ws.onmessage = (event) => {
						clearTimeout(timer);
						resolve(JSON.parse(event.data as string));
					};

					ws.onerror = () => {
						clearTimeout(timer);
						reject(new Error('WebSocket error'));
					};
				});

				ws.close();

				// The server must reject the subscription — a connect token is NOT a valid channel token
				assert.strictEqual(reply.type, 'error', 'Server should reject subscribe with a connect token used as channel token');
				assert.strictEqual(reply.channel, privateChannel, 'Error should reference the requested channel');
				assert.ok(
					reply.message && reply.message.includes('Unauthorized'),
					`Expected an Unauthorized error message, got: ${reply.message}`,
				);
			});
		});

		describe('Schema Validation', () => {
			test('publish with wrong shape is rejected', async () => {
				const api = getApi();
				await assert.rejects(
					() => api.realtimePublishBadData(),
					(err: unknown) => {
						const e = err as Error & { name: string };
						return e.name === 'ValidationFailedException'
							|| (e.message && e.message.includes('Validation'));
					},
					'Should reject data that does not match the cursor schema',
				);
			});
		});

		describe('Authorization', () => {
			test('valid token produces a working subscription', async () => {
				const api = getApi();
				const channel = await api.realtimeGetChannel('auth-ok');
				const sub = channel.subscribe(() => {});
				await sub.established;
				sub.unsubscribe();
			});

			test('invalid token is rejected on subscribe', async () => {
				const api = getApi();
				const badChannel = await api.realtimeGetPoisonedChannel('auth-tamper');
				const sub = badChannel.subscribe(() => {});
				await assert.rejects(
					sub.established,
					(err: unknown) => (err as Error & { name: string }).name === 'ConnectionFailedException',
					'Tampered token should reject the subscription',
				);
			});

			test('invalid token rejected on an already-established connection', async () => {
				const api = getApi();

				// First, establish a valid subscription
				const goodChannel = await api.realtimeGetChannel('auth-good');
				const goodMsgs: Cursor[] = [];
				const goodSub = goodChannel.subscribe((msg) => goodMsgs.push(msg));
				await goodSub.established;

				// Now subscribe with a poisoned token on the same connection
				const badChannel = await api.realtimeGetPoisonedChannel('auth-bad');
				const badSub = badChannel.subscribe(() => {});
				await assert.rejects(
					badSub.established,
					(err: unknown) => (err as Error & { name: string }).name === 'ConnectionFailedException',
					'Tampered token should be rejected even on an established connection',
				);

				// The good subscription should still work
				await api.realtimePublishToChannel('auth-good', { userId: 'u1', x: 0, y: 0, color: 'red' });
				await setTimeout(1000);

				assert.strictEqual(goodMsgs.length, 1, 'Valid subscription should still receive messages after bad subscribe attempt');

				goodSub.unsubscribe();
			});
		});

		describe('Subscribe Options Form', () => {
			test('options form receives messages via onMessage', async () => {
				const api = getApi();
				const cursor: Cursor = { userId: 'u1', x: 7, y: 8, color: 'teal' };
				const channel = await api.realtimeGetChannel('opts-msg');
				const received = new Promise<Cursor>((resolve, reject) => {
					const timer = globalThis.setTimeout(() => reject(new Error('No message within 10s')), 10000);
					const sub = channel.subscribe({
						onMessage: (msg) => {
							clearTimeout(timer);
							sub.unsubscribe();
							resolve(msg);
						},
					});
					sub.established.then(() => api.realtimePublishToChannel('opts-msg', cursor)).catch(reject);
				});
				assert.deepStrictEqual(await received, cursor);
			});

			test('onDisconnect fires with "client" on user-initiated unsubscribe', async () => {
				const api = getApi();
				const channel = await api.realtimeGetChannel('opts-unsub');
				const disconnected = new Promise<string>((resolve) => {
					const sub = channel.subscribe({
						onMessage: () => {},
						onDisconnect: (reason) => { resolve(reason); },
					});
					sub.established.then(() => { sub.unsubscribe(); });
				});
				assert.strictEqual(await disconnected, 'client');
			});

			test('onDisconnect fires when connection is forcefully closed', async () => {
				const api = getApi();
				const channel = await api.realtimeGetChannel('opts-dc');
				const disconnected = new Promise<string>((resolve, reject) => {
					const timer = globalThis.setTimeout(() => reject(new Error('onDisconnect not called within 5s')), 5000);
					const sub = channel.subscribe({
						onMessage: () => {},
						onDisconnect: (reason) => {
							clearTimeout(timer);
							resolve(reason);
						},
					});
					sub.established.then(() => {
						// Force-close the underlying WebSocket
						if (sub.connection) {
							sub.connection.close();
						} else {
							reject(new Error('No connection available to force-close'));
						}
					}).catch(reject);
				});
				const reason = await disconnected;
				assert.ok(
					reason === 'timeout' || reason === 'error' || reason === 'unknown',
					`Expected a DisconnectReason, got: ${reason}`,
				);
			});
		});

		describe('Limit Enforcement', () => {
			test('publish rejects channel path exceeding 1024 bytes', async () => {
				const api = getApi();
				await assert.rejects(
					() => api.realtimePublishOversizedChannel(),
					(err: unknown) => {
						const e = err as Error & { name: string };
						return e.name === 'ValidationFailedException'
							|| (e.message && e.message.includes('sort key'));
					},
					'Should reject channel path exceeding DynamoDB sort key limit',
				);
			});

			test('subscribe rejects channel path exceeding 1024 bytes', async () => {
				const api = getApi();
				await assert.rejects(
					() => api.realtimeSubscribeOversizedChannel(),
					(err: unknown) => {
						const e = err as Error & { name: string };
						return e.name === 'ValidationFailedException'
							|| (e.message && e.message.includes('sort key'));
					},
					'Should reject channel path exceeding DynamoDB sort key limit',
				);
			});

			test('getChannel rejects channel path exceeding 1024 bytes', async () => {
				const api = getApi();
				await assert.rejects(
					() => api.realtimeGetChannelOversized(),
					(err: unknown) => {
						const e = err as Error & { name: string };
						return e.name === 'ValidationFailedException'
							|| (e.message && e.message.includes('sort key'));
					},
					'Should reject channel path exceeding DynamoDB sort key limit',
				);
			});

			test('publish rejects message exceeding 32KB frame limit', async () => {
				const api = getApi();
				await assert.rejects(
					() => api.realtimePublishOversizedPayload(),
					(err: unknown) => {
						const e = err as Error & { name: string };
						return e.name === 'ValidationFailedException'
							|| (e.message && e.message.includes('frame'));
					},
					'Should reject message exceeding WebSocket frame limit',
				);
			});
		});

		describe('Type Safety', () => {
			test('subscribe() accepts both call signatures (compile-time check)', async () => {
				const api = getApi();
				const channel = await api.realtimeGetChannel('type-check');

				// Simple form
				const sub1 = channel.subscribe((_msg) => {});
				assert.ok(typeof sub1.unsubscribe === 'function');
				assert.ok(sub1.established instanceof Promise);
				sub1.unsubscribe();

				// Options form
				const sub2 = channel.subscribe({
					onMessage: (_msg) => {},
					onDisconnect: (_reason) => {},
				});
				assert.ok(typeof sub2.unsubscribe === 'function');
				assert.ok(sub2.established instanceof Promise);
				sub2.unsubscribe();
			});

			test('DisconnectReason type is correctly constrained', () => {
				// @ts-expect-error — 'user' is not a valid DisconnectReason
				const _bad: import('aws-blocks').DisconnectReason = 'user';

				const _good0: import('aws-blocks').DisconnectReason = 'client';
				const _good1: import('aws-blocks').DisconnectReason = 'timeout';
				const _good2: import('aws-blocks').DisconnectReason = 'error';
				const _good3: import('aws-blocks').DisconnectReason = 'unknown';
				assert.ok(true);
			});
		});
	});
}
