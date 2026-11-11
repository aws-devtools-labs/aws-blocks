// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The deployed Realtime runtime (index.aws.ts) must not cache a failed token
 * secret read. A transient failure at cold start (throttling, a network blip,
 * IAM still propagating) used to be cached for the container's lifetime, so
 * every later `getChannel()` failed until Lambda recycled the container.
 *
 * Under the default test conditions the token secret is the mock `AppSetting`
 * that `frameworkKey()` returns locally, so its `get()` is stubbed to fail a
 * fixed number of times.
 */
import assert from 'node:assert';
import { after, mock, test } from 'node:test';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import { isBlocksError, Scope } from '@aws-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { RealtimeErrors } from './errors.js';
import { Realtime } from './index.aws.js';

const anySchema: StandardSchemaV1<unknown> = {
	'~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) },
};

after(() => mock.restoreAll());

test('a failed token secret read is retried on the next call, not cached', async () => {
	let calls = 0;
	mock.method(AppSetting.prototype, 'get', async () => {
		calls += 1;
		// Call 1 is the constructor's pre-warm. The first getChannel() runs while
		// it is still in flight, so it shares that read and its failure.
		if (calls === 1) throw new Error('ThrottlingException: Rate exceeded');
		return 'a-token-secret-value';
	});

	const rt = new Realtime(new Scope(`rt-retry-${Math.random().toString(36).slice(2)}`), 'rt', { namespaces: { chat: Realtime.namespace(anySchema) } });

	await assert.rejects(rt.getChannel('chat', 'room-1'), (e: unknown) =>
		isBlocksError(e, RealtimeErrors.ConnectionFailed),
	);

	const channel = await rt.getChannel('chat', 'room-1');
	assert.ok(channel, 'the next call reads the secret again and succeeds');
	assert.strictEqual(calls, 2);

	// Once read, the value is cached: no further reads.
	await rt.getChannel('chat', 'room-2');
	assert.strictEqual(calls, 2);
});
