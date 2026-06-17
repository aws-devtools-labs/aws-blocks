// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { afterEach, mock, test } from 'node:test';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { EmailClient } from './index.aws.js';

function mockSesSend(fn: (cmd: unknown) => unknown) {
	return mock.method(SESv2Client.prototype, 'send', fn);
}

afterEach(() => {
	try {
		mock.restoreAll();
	} catch {}
});

test('sendBatch retries an entire chunk after a transient SES failure', async () => {
	let attempts = 0;
	mockSesSend(() => {
		attempts += 1;
		if (attempts === 1) {
			const err = new Error('rate exceeded');
			err.name = 'TooManyRequestsException';
			throw err;
		}
		return {
			BulkEmailEntryResults: [
				{ Status: 'SUCCESS', MessageId: 'msg-1' },
				{ Status: 'SUCCESS', MessageId: 'msg-2' },
			],
		};
	});

	const emailClient = new EmailClient({ id: 'root' } as any, 'retry', {
		fromAddress: 'noreply@example.com',
	});

	const result = await emailClient.sendBatch([
		{ to: 'one@example.com', subject: 'One', body: 'Body one' },
		{ to: 'two@example.com', subject: 'Two', body: 'Body two' },
	]);

	assert.strictEqual(attempts, 2);
	assert.deepStrictEqual(result.results, [
		{ status: 'success', messageId: 'msg-1' },
		{ status: 'success', messageId: 'msg-2' },
	]);
});

test('sendBatch does not retry a permanent SES failure', async () => {
	let attempts = 0;
	mockSesSend(() => {
		attempts += 1;
		const err = new Error('bad recipient');
		err.name = 'BadRequestException';
		throw err;
	});

	const emailClient = new EmailClient({ id: 'root' } as any, 'no-retry', {
		fromAddress: 'noreply@example.com',
	});

	const result = await emailClient.sendBatch([{ to: 'bad@example.com', subject: 'Bad', body: 'Body' }]);

	assert.strictEqual(attempts, 1);
	assert.strictEqual(result.results.length, 1);
	assert.strictEqual(result.results[0].status, 'failed');
	assert.match(result.results[0].error ?? '', /InvalidInputException/);
});
