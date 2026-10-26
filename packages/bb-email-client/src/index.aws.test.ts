// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the deployed (AWS) EmailClient with the SES client stubbed:
 * - it validates input exactly like the mock (shared `validation.ts`), so a
 *   message rejected locally is rejected when deployed, before any SES call;
 * - sendBatch() never places a plain-text body in an HTML part.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { Scope, isBlocksError } from '@aws-blocks/core';
import { SendBulkEmailCommand, type SendEmailCommand } from '@aws-sdk/client-sesv2';
import { EmailClient as AwsEmailClient, EmailErrors } from './index.aws.js';
import { EmailClient as MockEmailClient } from './index.mock.js';
import type { EmailMessage } from './types.js';

beforeEach(() => {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch {}
});

type Sent = SendEmailCommand | SendBulkEmailCommand;

/** An AWS EmailClient whose SES client records every command instead of calling SES. */
function awsClient(fromAddress = 'noreply@example.com'): { email: AwsEmailClient; sent: Sent[] } {
	const email = new AwsEmailClient(new Scope('app'), 'mail', { fromAddress });
	const sent: Sent[] = [];
	(email as unknown as { client: { send: (c: Sent) => Promise<unknown> } }).client.send = async (command: Sent) => {
		sent.push(command);
		if (command instanceof SendBulkEmailCommand) {
			return {
				BulkEmailEntryResults: (command.input.BulkEmailEntries ?? []).map((_, i) => ({
					Status: 'SUCCESS',
					MessageId: `bulk-${sent.length}-${i}`,
				})),
			};
		}
		return { MessageId: `single-${sent.length}` };
	};
	return { email, sent };
}

const fiftyOne = Array.from({ length: 51 }, (_, i) => `user${i}@example.com`);

// Inputs the mock has always rejected. The deployed client must reject them the
// same way, with the same error name, and without calling SES.
const INVALID_MESSAGES: Array<{ label: string; message: EmailMessage; from?: string; error: string }> = [
	{ label: 'malformed recipient', message: { to: 'not-an-email', subject: 's', body: 'b' }, error: EmailErrors.InvalidInput },
	{ label: 'malformed address in a list', message: { to: ['ok@example.com', 'bad'], subject: 's', body: 'b' }, error: EmailErrors.InvalidInput },
	{ label: 'malformed cc', message: { to: 'ok@example.com', cc: ['bad'], subject: 's', body: 'b' }, error: EmailErrors.InvalidInput },
	{ label: 'malformed bcc', message: { to: 'ok@example.com', bcc: ['bad'], subject: 's', body: 'b' }, error: EmailErrors.InvalidInput },
	{ label: 'CR/LF in an address', message: { to: 'ok@example.com\r\nBcc: victim@example.com', subject: 's', body: 'b' }, error: EmailErrors.InvalidInput },
	{ label: 'malformed sender', message: { to: 'ok@example.com', subject: 's', body: 'b' }, from: 'not-a-sender', error: EmailErrors.InvalidInput },
	{ label: 'more than 50 recipients', message: { to: fiftyOne, subject: 's', body: 'b' }, error: EmailErrors.InvalidInput },
	{ label: 'more than 40 MB', message: { to: 'ok@example.com', subject: 's', body: 'x'.repeat(40 * 1024 * 1024 + 1) }, error: EmailErrors.SendFailed },
];

for (const { label, message, from, error } of INVALID_MESSAGES) {
	test(`send() rejects ${label} on both the mock and AWS, without calling SES`, async () => {
		const mock = new MockEmailClient(new Scope('app'), 'mail', { fromAddress: from ?? 'noreply@example.com' });
		await assert.rejects(() => mock.send(message), (e: unknown) => isBlocksError(e, error));

		const { email, sent } = awsClient(from);
		await assert.rejects(() => email.send(message), (e: unknown) => isBlocksError(e, error));
		assert.strictEqual(sent.length, 0, 'an invalid message must not reach SES');
	});
}

test('send() accepts a display-name address (Name <addr>) on both the mock and AWS', async () => {
	const message: EmailMessage = { to: 'Jane Doe <jane@example.com>', subject: 's', body: 'b' };
	const mock = new MockEmailClient(new Scope('app'), 'mail', { fromAddress: 'Example <noreply@example.com>' });
	await mock.send(message);
	const { email, sent } = awsClient('Example <noreply@example.com>');
	await email.send(message);
	assert.strictEqual(sent.length, 1);
});

test('sendBatch() marks an invalid entry failed without sending it, like the mock', async () => {
	const { email, sent } = awsClient();
	const { results } = await email.sendBatch([
		{ to: 'ok@example.com', subject: 'a', body: 'a' },
		{ to: 'bad', subject: 'b', body: 'b' },
		{ to: fiftyOne, subject: 'c', body: 'c' },
	]);
	assert.strictEqual(results[0].status, 'success');
	assert.strictEqual(results[1].status, 'failed');
	assert.match(results[1].error ?? '', /Invalid email address/);
	assert.strictEqual(results[2].status, 'failed');
	assert.match(results[2].error ?? '', /Recipient count exceeds 50/);
	const entries = sent.flatMap((c) => (c as SendBulkEmailCommand).input.BulkEmailEntries ?? []);
	assert.strictEqual(entries.length, 1, 'only the valid entry is sent');
});

test('sendBatch() sends a text-only message with no HTML part', async () => {
	const { email, sent } = awsClient();
	const body = 'Hi <b>there</b>, click <a href="https://example.com">here</a>';
	const { results } = await email.sendBatch([{ to: 'ok@example.com', subject: 'Plain', body }]);
	assert.strictEqual(results[0].status, 'success');
	assert.strictEqual(sent.length, 1);
	const input = (sent[0] as SendBulkEmailCommand).input;
	const content = input.DefaultContent?.Template?.TemplateContent;
	assert.strictEqual(content?.Html, undefined, 'a text-only message must not get an HTML part');
	assert.strictEqual(content?.Text, '{{body}}');
	const data = JSON.parse(input.BulkEmailEntries?.[0].ReplacementEmailContent?.ReplacementTemplate?.ReplacementTemplateData ?? '{}');
	assert.strictEqual(data.body, body);
	assert.ok(!('html' in data), 'the plain-text body must not be passed as html');
});

test('sendBatch() keeps the HTML part for messages that set html', async () => {
	const { email, sent } = awsClient();
	await email.sendBatch([{ to: 'ok@example.com', subject: 'Rich', body: 'text', html: '<p>rich</p>' }]);
	const input = (sent[0] as SendBulkEmailCommand).input;
	assert.strictEqual(input.DefaultContent?.Template?.TemplateContent?.Html, '{{html}}');
	const data = JSON.parse(input.BulkEmailEntries?.[0].ReplacementEmailContent?.ReplacementTemplate?.ReplacementTemplateData ?? '{}');
	assert.strictEqual(data.html, '<p>rich</p>');
	assert.strictEqual(data.body, 'text');
});

test('sendBatch() with mixed messages returns results in input order', async () => {
	const { email, sent } = awsClient();
	const { results } = await email.sendBatch([
		{ to: 'a@example.com', subject: 'a', body: 'a' },
		{ to: 'b@example.com', subject: 'b', body: 'b', html: '<p>b</p>' },
		{ to: 'c@example.com', subject: 'c', body: 'c' },
	]);
	assert.deepStrictEqual(results.map((r) => r.status), ['success', 'success', 'success']);
	assert.strictEqual(sent.length, 2, 'one call with an HTML part, one without');
	const destinations = (c: Sent) => ((c as SendBulkEmailCommand).input.BulkEmailEntries ?? []).map((e) => e.Destination?.ToAddresses?.[0]);
	const htmlCall = sent.find((c) => (c as SendBulkEmailCommand).input.DefaultContent?.Template?.TemplateContent?.Html);
	const textCall = sent.find((c) => !(c as SendBulkEmailCommand).input.DefaultContent?.Template?.TemplateContent?.Html);
	assert.deepStrictEqual(htmlCall && destinations(htmlCall), ['b@example.com']);
	assert.deepStrictEqual(textCall && destinations(textCall), ['a@example.com', 'c@example.com']);
	// Each result carries the message id of the entry it was sent as.
	assert.ok(results.every((r) => typeof r.messageId === 'string' && r.messageId.length > 0));
});
