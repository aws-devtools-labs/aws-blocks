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

test('rejected characters past the truncation point keep the deployed names', () => {
	// Both old names stop before the `.`, so this job deploys today; renaming it
	// would replace its queues.
	const fullId = `app-${'x'.repeat(100)}.tail`;
	assert.deepStrictEqual(deriveQueueNames(fullId), {
		queueName: fullId.substring(0, 80),
		dlqName: `${fullId.substring(0, 76)}-dlq`,
	});
});

test('a rejected character inside either old name switches both to hashed names', () => {
	// Position 78: past the DLQ's 76 characters, inside the queue's 80, so the
	// old queue name was undeployable.
	const fullId = `${'q'.repeat(78)}.${'z'.repeat(10)}`;
	const { queueName, dlqName } = deriveQueueNames(fullId);
	assert.match(queueName, /-[0-9a-f]{8}$/);
	assert.match(dlqName, /-[0-9a-f]{8}-dlq$/);
	assert.match(queueName, SQS_NAME);
	assert.match(dlqName, SQS_NAME);
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
