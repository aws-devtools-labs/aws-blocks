// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import { OtelLogger } from './index.aws.js';
import { coerceAttributes } from './serializer.js';
import { OtelLoggingErrors } from './errors.js';

const fakeScope = { id: 'root' } as any;

afterEach(() => {
	delete (globalThis as any).__BLOCKS_OTEL_SDK__;
	delete (globalThis as any).__BLOCKS_OTEL_FLUSHERS__;
});

describe('OtelLogger — surface', () => {
	test('extends Scope and exposes the four levels + child', () => {
		const log = new OtelLogger(fakeScope, 'app');
		assert.strictEqual(log.fullId, 'root-app');
		for (const m of ['debug', 'info', 'warn', 'error', 'child'] as const) {
			assert.ok(typeof (log as any)[m] === 'function');
		}
	});

	test('log calls do not throw; child returns a logger', () => {
		const log = new OtelLogger(fakeScope, 'app', { level: 'debug', defaultContext: { svc: 'api' } });
		assert.doesNotThrow(() => log.info('hello', { userId: 'u1' }));
		assert.doesNotThrow(() => log.error('boom', { err: new Error('x') }));
		const child = log.child({ requestId: 'r1' });
		assert.ok(typeof child.info === 'function');
		assert.doesNotThrow(() => child.warn('slow'));
	});

	test('rawLogger exposes the OTel logger (emit)', () => {
		const log = new OtelLogger(fakeScope, 'app');
		assert.ok(typeof log.rawLogger.emit === 'function');
	});

	test('registers an OTel flusher on construction', () => {
		new OtelLogger(fakeScope, 'app');
		const flushers = (globalThis as any).__BLOCKS_OTEL_FLUSHERS__ as Set<unknown> | undefined;
		assert.ok(flushers && flushers.size >= 1);
	});
});

describe('coerceAttributes', () => {
	test('passes primitives through and merges contexts (later wins)', () => {
		const attrs = coerceAttributes([{ a: 1, b: 'x' }, { b: 'y', c: true }]);
		assert.deepStrictEqual(attrs, { a: 1, b: 'y', c: true });
	});

	test('extracts Error instances to a serialized string', () => {
		const attrs = coerceAttributes([{ err: new Error('boom') }]);
		assert.match(String(attrs.err), /"name":"Error".*"message":"boom"/s);
	});

	test('stringifies complex objects and survives circular refs', () => {
		const circular: any = { a: 1 };
		circular.self = circular;
		const attrs = coerceAttributes([{ obj: circular }]);
		assert.match(String(attrs.obj), /\[Circular\]/);
	});

	test('converts bigint to string and keeps primitive arrays', () => {
		const attrs = coerceAttributes([{ big: 10n, list: [1, 2, 3] }]);
		assert.strictEqual(attrs.big, '10');
		assert.deepStrictEqual(attrs.list, [1, 2, 3]);
	});

	test('SerializationFailed marker is defined', () => {
		assert.strictEqual(OtelLoggingErrors.SerializationFailed, 'SerializationFailedException');
	});
});
