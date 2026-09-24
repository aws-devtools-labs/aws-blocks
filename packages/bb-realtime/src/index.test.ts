// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { Realtime, RealtimeErrors } from './index.js';
import { LOCAL_TOKEN_SECRET } from './local-dev.js';
import { mintChannelToken, validateChannelToken } from './utils.js';

// Minimal StandardSchemaV1 implementation for testing
function testSchema<T>(): import('@standard-schema/spec').StandardSchemaV1<T> {
	return {
		'~standard': {
			version: 1 as const,
			vendor: 'test' as const,
			validate(value: unknown) {
				return { value: value as T };
			},
		},
	};
}

function strictSchema<T>(validator: (v: unknown) => string | null): import('@standard-schema/spec').StandardSchemaV1<T> {
	return {
		'~standard': {
			version: 1 as const,
			vendor: 'test' as const,
			validate(value: unknown) {
				const error = validator(value);
				if (error) return { issues: [{ message: error }] };
				return { value: value as T };
			},
		},
	};
}

const mockScope = { id: 'test-app' };

describe('Realtime', () => {
	// ── Construction ──────────────────────────────────────────────────────

	it('should create a Realtime instance with namespaces', () => {
		const rt = new Realtime(mockScope, 'rt', {
			namespaces: { events: Realtime.namespace(testSchema()) },
		});
		assert.ok(rt);
		assert.strictEqual(rt.fullId, 'test-app-rt');
	});

	it('should expose publish, subscribe, getChannel methods', () => {
		const rt = new Realtime(mockScope, 'rt', {
			namespaces: { events: Realtime.namespace(testSchema()) },
		});
		assert.strictEqual(typeof rt.publish, 'function');
		assert.strictEqual(typeof rt.subscribe, 'function');
		assert.strictEqual(typeof rt.getChannel, 'function');
	});

	// ── Publish & Subscribe ──────────────────────────────────────────────

	it('should publish and receive messages on a channel', async () => {
		const rt = new Realtime(mockScope, 'pub', {
			namespaces: { events: Realtime.namespace(testSchema<{ value: number }>()) },
		});
		const received: unknown[] = [];

		rt.subscribe('events', 'ch1', (msg) => { received.push(msg); });
		await rt.publish('events', 'ch1', { value: 42 });

		assert.strictEqual(received.length, 1);
		assert.deepStrictEqual(received[0], { value: 42 });
	});

	it('should isolate channels within a namespace', async () => {
		const rt = new Realtime(mockScope, 'iso-sub', {
			namespaces: { events: Realtime.namespace(testSchema()) },
		});
		const ch1: unknown[] = [];
		const ch2: unknown[] = [];

		rt.subscribe('events', 'a', (msg) => ch1.push(msg));
		rt.subscribe('events', 'b', (msg) => ch2.push(msg));

		await rt.publish('events', 'a', { for: 'a' });
		await rt.publish('events', 'b', { for: 'b' });

		assert.strictEqual(ch1.length, 1);
		assert.strictEqual(ch2.length, 1);
		assert.deepStrictEqual(ch1[0], { for: 'a' });
		assert.deepStrictEqual(ch2[0], { for: 'b' });
	});

	it('should isolate namespaces', async () => {
		const rt = new Realtime(mockScope, 'iso-ns', {
			namespaces: {
				cursors: Realtime.namespace(testSchema()),
				chat: Realtime.namespace(testSchema()),
			},
		});
		const cursors: unknown[] = [];
		const chat: unknown[] = [];

		rt.subscribe('cursors', 'room', (msg) => cursors.push(msg));
		rt.subscribe('chat', 'room', (msg) => chat.push(msg));

		await rt.publish('cursors', 'room', { x: 1 });
		await rt.publish('chat', 'room', { text: 'hi' });

		assert.strictEqual(cursors.length, 1);
		assert.strictEqual(chat.length, 1);
		assert.deepStrictEqual(cursors[0], { x: 1 });
		assert.deepStrictEqual(chat[0], { text: 'hi' });
	});

	it('should isolate instances by id', async () => {
		const rt1 = new Realtime(mockScope, 'inst1', {
			namespaces: { events: Realtime.namespace(testSchema()) },
		});
		const rt2 = new Realtime(mockScope, 'inst2', {
			namespaces: { events: Realtime.namespace(testSchema()) },
		});
		const r1: unknown[] = [];
		const r2: unknown[] = [];

		rt1.subscribe('events', 'ch', (msg) => r1.push(msg));
		rt2.subscribe('events', 'ch', (msg) => r2.push(msg));

		await rt1.publish('events', 'ch', { from: 'inst1' });

		assert.strictEqual(r1.length, 1);
		assert.strictEqual(r2.length, 0);
	});

	it('should not receive messages after unsubscribe', async () => {
		const rt = new Realtime(mockScope, 'unsub', {
			namespaces: { events: Realtime.namespace(testSchema()) },
		});
		const received: unknown[] = [];

		const unsub = rt.subscribe('events', 'ch', (msg) => { received.push(msg); });
		await rt.publish('events', 'ch', { first: true });
		unsub();
		await rt.publish('events', 'ch', { second: true });

		assert.strictEqual(received.length, 1);
		assert.deepStrictEqual(received[0], { first: true });
	});

	// ── Schema Validation ────────────────────────────────────────────────

	it('should reject invalid data on publish', async () => {
		const schema = strictSchema<{ name: string }>((v) => {
			if (typeof v !== 'object' || v === null || typeof (v as any).name !== 'string') {
				return 'name must be a string';
			}
			return null;
		});
		const rt = new Realtime(mockScope, 'validate', {
			namespaces: { events: Realtime.namespace(schema) },
		});

		await assert.rejects(
			() => rt.publish('events', 'ch', { name: 123 } as any),
			(err: Error) => err.name === RealtimeErrors.ValidationFailed,
		);
	});

	it('should accept valid data on publish', async () => {
		const schema = strictSchema<{ name: string }>((v) => {
			if (typeof v !== 'object' || v === null || typeof (v as any).name !== 'string') {
				return 'name must be a string';
			}
			return null;
		});
		const rt = new Realtime(mockScope, 'validate-ok', {
			namespaces: { events: Realtime.namespace(schema) },
		});
		const received: unknown[] = [];

		rt.subscribe('events', 'ch', (msg) => received.push(msg));
		await rt.publish('events', 'ch', { name: 'alice' });

		assert.strictEqual(received.length, 1);
		assert.deepStrictEqual(received[0], { name: 'alice' });
	});

	// ── Channel Handle (Transferable) ────────────────────────────────────

	it('getChannel() should return a Transferable with toJSON', async () => {
		const rt = new Realtime(mockScope, 'xfer', {
			namespaces: { events: Realtime.namespace(testSchema()) },
		});

		const ch = await rt.getChannel('events', 'room-1');
		const json = ch.toJSON();

		assert.strictEqual(json.__blocks, 'realtime/channel');
		assert.ok(json.channel.includes('xfer'));
		assert.ok(json.channel.includes('events'));
		assert.ok(json.channel.includes('room-1'));
	});

	it('getChannel() handle should subscribe to messages', async () => {
		const rt = new Realtime(mockScope, 'xfer-ps', {
			namespaces: { events: Realtime.namespace(testSchema()) },
		});

		const ch = await rt.getChannel('events', 'room-1');
		const received: unknown[] = [];

		ch.subscribe((msg) => received.push(msg));
		await rt.publish('events', 'room-1', { data: 'hello' });

		assert.strictEqual(received.length, 1);
		assert.deepStrictEqual(received[0], { data: 'hello' });
	});

	it('publish validates against schema', async () => {
		const schema = strictSchema<{ x: number }>((v) => {
			if (typeof v !== 'object' || v === null || typeof (v as any).x !== 'number') {
				return 'x must be a number';
			}
			return null;
		});
		const rt = new Realtime(mockScope, 'xfer-val', {
			namespaces: { events: Realtime.namespace(schema) },
		});

		await assert.rejects(
			() => rt.publish('events', 'room-1', { x: 'not a number' } as any),
			(err: Error) => err.name === RealtimeErrors.ValidationFailed,
		);
	});

	// ── Error Constants ──────────────────────────────────────────────────

	it('RealtimeErrors has expected constants', () => {
		assert.strictEqual(RealtimeErrors.PublishFailed, 'PublishFailedException');
		assert.strictEqual(RealtimeErrors.ValidationFailed, 'ValidationFailedException');
		assert.strictEqual(RealtimeErrors.ConnectionFailed, 'ConnectionFailedException');
	});

	// ── Static namespace() helper ────────────────────────────────────────

	it('Realtime.namespace() returns a config with schema', () => {
		const schema = testSchema<{ x: number }>();
		const config = Realtime.namespace(schema);
		assert.strictEqual(config.schema, schema);
	});

	// ── Primitive Types ──────────────────────────────────────────────────

	it('should publish and receive string primitives', async () => {
		const schema = strictSchema<string>((v) => typeof v === 'string' ? null : 'must be string');
		const rt = new Realtime(mockScope, 'prim-str', {
			namespaces: { msgs: Realtime.namespace(schema) },
		});
		const received: string[] = [];

		rt.subscribe('msgs', 'ch', (msg) => received.push(msg));
		await rt.publish('msgs', 'ch', 'hello world');

		assert.strictEqual(received.length, 1);
		assert.strictEqual(received[0], 'hello world');
	});

	it('should publish and receive number primitives', async () => {
		const schema = strictSchema<number>((v) => typeof v === 'number' ? null : 'must be number');
		const rt = new Realtime(mockScope, 'prim-num', {
			namespaces: { msgs: Realtime.namespace(schema) },
		});
		const received: number[] = [];

		rt.subscribe('msgs', 'ch', (msg) => received.push(msg));
		await rt.publish('msgs', 'ch', 42);

		assert.strictEqual(received.length, 1);
		assert.strictEqual(received[0], 42);
	});

	it('should publish and receive boolean primitives', async () => {
		const schema = strictSchema<boolean>((v) => typeof v === 'boolean' ? null : 'must be boolean');
		const rt = new Realtime(mockScope, 'prim-bool', {
			namespaces: { msgs: Realtime.namespace(schema) },
		});
		const received: boolean[] = [];

		rt.subscribe('msgs', 'ch', (msg) => received.push(msg));
		await rt.publish('msgs', 'ch', true);

		assert.strictEqual(received.length, 1);
		assert.strictEqual(received[0], true);
	});

	it('should publish and receive arrays', async () => {
		const schema = strictSchema<number[]>((v) => Array.isArray(v) ? null : 'must be array');
		const rt = new Realtime(mockScope, 'prim-arr', {
			namespaces: { msgs: Realtime.namespace(schema) },
		});
		const received: number[][] = [];

		rt.subscribe('msgs', 'ch', (msg) => received.push(msg));
		await rt.publish('msgs', 'ch', [1, 2, 3]);

		assert.strictEqual(received.length, 1);
		assert.deepStrictEqual(received[0], [1, 2, 3]);
	});

	// ── Wrong Shape Rejection ────────────────────────────────────────────

	it('should reject string when object expected', async () => {
		const schema = strictSchema<{ name: string }>((v) => {
			if (typeof v !== 'object' || v === null) return 'must be object';
			if (typeof (v as any).name !== 'string') return 'name must be string';
			return null;
		});
		const rt = new Realtime(mockScope, 'wrong-str', {
			namespaces: { events: Realtime.namespace(schema) },
		});

		await assert.rejects(
			() => rt.publish('events', 'ch', 'not an object' as any),
			(err: Error) => err.name === RealtimeErrors.ValidationFailed,
		);
	});

	it('should reject number when object expected', async () => {
		const schema = strictSchema<{ count: number }>((v) => {
			if (typeof v !== 'object' || v === null) return 'must be object';
			return null;
		});
		const rt = new Realtime(mockScope, 'wrong-num', {
			namespaces: { events: Realtime.namespace(schema) },
		});

		await assert.rejects(
			() => rt.publish('events', 'ch', 999 as any),
			(err: Error) => err.name === RealtimeErrors.ValidationFailed,
		);
	});

	it('should reject null when object expected', async () => {
		const schema = strictSchema<{ id: string }>((v) => {
			if (typeof v !== 'object' || v === null) return 'must be non-null object';
			return null;
		});
		const rt = new Realtime(mockScope, 'wrong-null', {
			namespaces: { events: Realtime.namespace(schema) },
		});

		await assert.rejects(
			() => rt.publish('events', 'ch', null as any),
			(err: Error) => err.name === RealtimeErrors.ValidationFailed,
		);
	});

	it('should reject object with missing required fields', async () => {
		const schema = strictSchema<{ x: number; y: number }>((v) => {
			if (typeof v !== 'object' || v === null) return 'must be object';
			if (typeof (v as any).x !== 'number') return 'x required';
			if (typeof (v as any).y !== 'number') return 'y required';
			return null;
		});
		const rt = new Realtime(mockScope, 'wrong-missing', {
			namespaces: { events: Realtime.namespace(schema) },
		});

		await assert.rejects(
			() => rt.publish('events', 'ch', { x: 1 } as any),
			(err: Error) => err.name === RealtimeErrors.ValidationFailed,
		);
	});

	it('should reject wrong field types', async () => {
		const schema = strictSchema<{ count: number }>((v) => {
			if (typeof v !== 'object' || v === null) return 'must be object';
			if (typeof (v as any).count !== 'number') return 'count must be number';
			return null;
		});
		const rt = new Realtime(mockScope, 'wrong-field', {
			namespaces: { events: Realtime.namespace(schema) },
		});

		await assert.rejects(
			() => rt.publish('events', 'ch', { count: 'not a number' } as any),
			(err: Error) => err.name === RealtimeErrors.ValidationFailed,
		);
	});

	it('getChannel() handle should reject wrong shape on publish', async () => {
		const schema = strictSchema<{ text: string }>((v) => {
			if (typeof v !== 'object' || v === null || typeof (v as any).text !== 'string') {
				return 'text must be string';
			}
			return null;
		});
		const rt = new Realtime(mockScope, 'xfer-wrong', {
			namespaces: { events: Realtime.namespace(schema) },
		});

		await assert.rejects(
			() => rt.publish('events', 'room-1', { text: 42 } as any),
			(err: Error) => err.name === RealtimeErrors.ValidationFailed,
		);
	});

	// ── Invalid Namespace ────────────────────────────────────────────────

	it('should throw on unknown namespace', async () => {
		const rt = new Realtime(mockScope, 'bad-ns', {
			namespaces: { events: Realtime.namespace(testSchema()) },
		});

		await assert.rejects(
			() => rt.publish('nonexistent' as any, 'ch', {}),
			(err: Error) => err.name === 'InvalidNamespace',
		);
	});

	// ── Compile-Time Type Safety (ts-expect-error) ───────────────────────

	it('type system prevents wrong publish types', () => {
		const schema = strictSchema<{ x: number }>(() => null);
		const rt = new Realtime(mockScope, 'ts-check', {
			namespaces: { events: Realtime.namespace(schema) },
		});

		// These should compile:
		rt.publish('events', 'ch', { x: 1 });

		// @ts-expect-error — string instead of { x: number }
		rt.publish('events', 'ch', 'wrong');

		// @ts-expect-error — wrong field type
		rt.publish('events', 'ch', { x: 'not a number' });

		// @ts-expect-error — missing required field
		rt.publish('events', 'ch', {});

		// @ts-expect-error — extra field not in schema
		rt.publish('events', 'ch', { x: 1, y: 2 });

		assert.ok(true); // test is compile-time only
	});

	it('type system prevents accessing non-existent namespaces', () => {
		const rt = new Realtime(mockScope, 'ts-ns', {
			namespaces: { chat: Realtime.namespace(strictSchema<string>(() => null)) },
		});

		// This should compile:
		rt.publish('chat', 'ch', 'hello');

		// @ts-expect-error — 'cursors' namespace doesn't exist
		rt.publish('cursors', 'ch', 'hello').catch(() => {});

		assert.ok(true);
	});

	// ── Token Minting & Validation ───────────────────────────────────────

	it('mintChannelToken produces a valid token', () => {
		const token = mintChannelToken('/ns/chat/room-1', 'secret123');
		const result = validateChannelToken(token, 'secret123');
		assert.ok(result);
		assert.strictEqual(result!.channel, '/ns/chat/room-1');
		assert.ok(result!.exp > Math.floor(Date.now() / 1000));
	});

	it('validateChannelToken rejects wrong secret', () => {
		const token = mintChannelToken('/ns/chat/room-1', 'secret123');
		const result = validateChannelToken(token, 'wrong-secret');
		assert.strictEqual(result, null);
	});

	it('validateChannelToken rejects expired token', () => {
		const token = mintChannelToken('/ns/chat/room-1', 'secret123', -1); // already expired
		const result = validateChannelToken(token, 'secret123');
		assert.strictEqual(result, null);
	});

	it('validateChannelToken rejects token for wrong channel', () => {
		const token = mintChannelToken('/ns/chat/room-1', 'secret123');
		const result = validateChannelToken(token, 'secret123', '/ns/chat/room-2');
		assert.strictEqual(result, null);
	});

	it('validateChannelToken accepts token for sub-path of authorized channel', () => {
		const token = mintChannelToken('/ns/chat', 'secret123');
		const result = validateChannelToken(token, 'secret123', '/ns/chat/room-1');
		assert.ok(result);
	});

	it('validateChannelToken rejects channel that shares a prefix but is not a sub-path', () => {
		const token = mintChannelToken('/ns/chat/room-1', 'secret123');
		const result = validateChannelToken(token, 'secret123', '/ns/chat/room-12345');
		assert.strictEqual(result, null);
	});

	it('validateChannelToken rejects garbage token', () => {
		assert.strictEqual(validateChannelToken('garbage', 'secret'), null);
		assert.strictEqual(validateChannelToken('', 'secret'), null);
		assert.strictEqual(validateChannelToken('a.b.c', 'secret'), null);
	});

	it('validateChannelToken rejects tampered payload', () => {
		const token = mintChannelToken('/ns/chat/room-1', 'secret123');
		const [_payload, sig] = token.split('.');
		// Tamper: change channel in payload
		const tampered = Buffer.from(JSON.stringify({ channel: '/ns/admin/secret', exp: 9999999999 })).toString('base64url');
		const result = validateChannelToken(`${tampered}.${sig}`, 'secret123');
		assert.strictEqual(result, null);
	});

	it('validateChannelToken rejects token with missing channel field when requestedChannel is provided', () => {
		// Craft a validly-signed token that has no channel field
		const payload = { exp: Math.floor(Date.now() / 1000) + 3600 };
		const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
		const sig = createHmac('sha256', 'secret123').update(JSON.stringify(payload)).digest('base64url');
		const token = `${payloadB64}.${sig}`;
		// Without requestedChannel, it should pass (connection use)
		const connResult = validateChannelToken(token, 'secret123');
		assert.ok(connResult, 'token without channel should validate for connection');
		// With requestedChannel, it must fail — tokens must declare what they authorize
		const subResult = validateChannelToken(token, 'secret123', '/ns/chat/room-1');
		assert.strictEqual(subResult, null, 'token without channel field must NOT authorize channel subscriptions');
	});

	// ── Channel Handle Token ─────────────────────────────────────────────

	it('getChannel() toJSON includes a valid token', async () => {
		const rt = new Realtime(mockScope, 'auth-tok', {
			namespaces: { events: Realtime.namespace(testSchema<string>()) },
		});

		const ch = await rt.getChannel('events', 'room-1');
		const json = ch.toJSON();

		assert.ok(json.token, 'toJSON should include a token');
		const result = validateChannelToken(json.token as string, LOCAL_TOKEN_SECRET, json.channel);
		assert.ok(result, 'token should be valid for the channel');
	});

	it('getChannel() token is invalid with wrong secret', async () => {
		const rt = new Realtime(mockScope, 'auth-bad', {
			namespaces: { events: Realtime.namespace(testSchema<string>()) },
		});

		const json = (await rt.getChannel('events', 'room-1')).toJSON();
		const result = validateChannelToken(json.token as string, 'totally-wrong-secret');
		assert.strictEqual(result, null);
	});

	it('getChannel() token is scoped to the specific channel', async () => {
		const rt = new Realtime(mockScope, 'auth-scope', {
			namespaces: { events: Realtime.namespace(testSchema<string>()) },
		});

		const json = (await rt.getChannel('events', 'room-1')).toJSON();
		// Token for room-1 should NOT authorize room-2
		const result = validateChannelToken(json.token as string, LOCAL_TOKEN_SECRET, 'test-app-auth-scope/events/room-2');
		assert.strictEqual(result, null);
	});

	// ── Channel Path Length Validation (DynamoDB SK limit) ────────────────

	it('should reject channel path exceeding 1024 bytes on publish', async () => {
		const rt = new Realtime(mockScope, 'len', {
			namespaces: { ns: Realtime.namespace(testSchema()) },
		});
		// fullChannel = "test-app-len/ns/{channel}" — prefix is 15 bytes
		const longChannel = 'x'.repeat(1010);
		await assert.rejects(
			() => rt.publish('ns', longChannel, {}),
			(err: Error) => err.name === RealtimeErrors.ValidationFailed && err.message.includes('sort key'),
		);
	});

	it('should reject channel path exceeding 1024 bytes on subscribe', () => {
		const rt = new Realtime(mockScope, 'len-sub', {
			namespaces: { ns: Realtime.namespace(testSchema()) },
		});
		const longChannel = 'x'.repeat(1010);
		assert.throws(
			() => rt.subscribe('ns', longChannel, () => {}),
			(err: Error) => err.name === RealtimeErrors.ValidationFailed && err.message.includes('sort key'),
		);
	});

	it('should reject channel path exceeding 1024 bytes on getChannel', async () => {
		const rt = new Realtime(mockScope, 'len-gc', {
			namespaces: { ns: Realtime.namespace(testSchema()) },
		});
		const longChannel = 'x'.repeat(1010);
		await assert.rejects(
			() => rt.getChannel('ns', longChannel),
			(err: Error) => err.name === RealtimeErrors.ValidationFailed && err.message.includes('sort key'),
		);
	});

	it('should accept channel path at exactly 1024 bytes', async () => {
		const rt = new Realtime(mockScope, 'len-ok', {
			namespaces: { ns: Realtime.namespace(testSchema()) },
		});
		// prefix = "test-app-len-ok/ns/" = 19 bytes
		const channel = 'x'.repeat(1024 - 19);
		const received: unknown[] = [];
		rt.subscribe('ns', channel, (msg) => received.push(msg));
		await rt.publish('ns', channel, { ok: true });
		assert.strictEqual(received.length, 1);
	});

	it('should count multi-byte UTF-8 characters correctly', async () => {
		const rt = new Realtime(mockScope, 'len-utf', {
			namespaces: { ns: Realtime.namespace(testSchema()) },
		});
		// prefix = "test-app-len-utf/ns/" = 20 bytes
		// Each emoji is 4 bytes UTF-8. 252 emojis = 1008 bytes + 20 = 1028 > 1024
		const channel = '😀'.repeat(252);
		await assert.rejects(
			() => rt.publish('ns', channel, {}),
			(err: Error) => err.name === RealtimeErrors.ValidationFailed && err.message.includes('sort key'),
		);
	});

	// ── Publish Size Validation (WebSocket frame limit) ──────────────────

	it('should reject publish payload exceeding 32KB', async () => {
		const rt = new Realtime(mockScope, 'size', {
			namespaces: { ns: Realtime.namespace(testSchema()) },
		});
		const bigData = { payload: 'x'.repeat(33_000) };
		await assert.rejects(
			() => rt.publish('ns', 'ch', bigData),
			(err: Error) => err.name === RealtimeErrors.ValidationFailed && err.message.includes('frame'),
		);
	});

	it('should accept publish payload just under 32KB', async () => {
		const rt = new Realtime(mockScope, 'size-ok', {
			namespaces: { ns: Realtime.namespace(testSchema()) },
		});
		// envelope: {"type":"message","channel":"test-app-size-ok/ns/ch","data":{"payload":"..."}}
		// ~70 bytes overhead, so 32600 bytes of payload is safely under 32768
		const data = { payload: 'x'.repeat(32_600) };
		const received: unknown[] = [];
		rt.subscribe('ns', 'ch', (msg) => received.push(msg));
		await rt.publish('ns', 'ch', data);
		assert.strictEqual(received.length, 1);
	});
});
