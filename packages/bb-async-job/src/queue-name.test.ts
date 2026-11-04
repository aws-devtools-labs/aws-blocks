// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { deriveQueueNames } from './queue-name.js';

const SQS_NAME = /^[A-Za-z0-9_-]{1,80}$/;

test('a fullId SQS accepts keeps the names deployed jobs already have', () => {
	assert.deepStrictEqual(deriveQueueNames('app-emails'), { queueName: 'app-emails', dlqName: 'app-emails-dlq' });
	const long = `app-${'x'.repeat(100)}`;
	assert.deepStrictEqual(deriveQueueNames(long), {
		queueName: long.substring(0, 80),
		dlqName: `${long.substring(0, 76)}-dlq`,
	});
});

test('a fullId with characters SQS rejects gets valid, distinct names', () => {
	const dotted = deriveQueueNames('app-incoming.files-on-object-created');
	assert.match(dotted.queueName, SQS_NAME);
	assert.match(dotted.dlqName, SQS_NAME);
	assert.match(dotted.queueName, /^app-incoming-files-on-object-created-[0-9a-f]{8}$/);
	assert.strictEqual(dotted.dlqName, `${dotted.queueName}-dlq`);
	// Its sanitized twin is a valid fullId of its own; the hash keeps them apart.
	assert.notStrictEqual(dotted.queueName, deriveQueueNames('app-incoming-files-on-object-created').queueName);
	assert.deepStrictEqual(deriveQueueNames('app-incoming.files-on-object-created'), dotted);
});

test('a long fullId with rejected characters still fits 80 characters, DLQ included', () => {
	const { queueName, dlqName } = deriveQueueNames(`app.${'y'.repeat(120)}`);
	assert.match(queueName, SQS_NAME);
	assert.match(dlqName, SQS_NAME);
	assert.notStrictEqual(queueName, dlqName);
});
