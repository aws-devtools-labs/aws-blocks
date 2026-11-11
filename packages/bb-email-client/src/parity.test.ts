// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock↔AWS parity for `EmailClient.send()` and `sendBatch()` input validation.
 *
 * One table of cases runs against the local mock and against the AWS runtime
 * with `SESv2Client.send` stubbed. Both must reach the same outcome: the same
 * named `EmailErrors` error (and message), or success. Success cases also assert
 * the captured SES input, so a stub that rejects every command can't make a
 * case pass; rejected cases assert that nothing reached SES. Both entries call
 * the shared `validation.ts`; this suite pins that they keep doing so.
 *
 * `index.aws.test.ts` covers address formats, batch chunking and SES error
 * mapping in more depth. Following `bb-file-bucket/src/parity.test.ts`.
 */
import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { Scope } from '@aws-blocks/core';
import { EmailClient as AwsEmailClient, EmailErrors } from './index.aws.js';
import { EmailClient as MockEmailClient } from './index.mock.js';
import type { EmailMessage, EmailOptions } from './types.js';

beforeEach(() => {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch {}
});

let n = 0;
const uniqueId = () => `email-parity-${n++}`;

type Outcome = { ok: true } | { ok: false; name: string; message: string };

async function outcomeOf(fn: () => Promise<unknown>): Promise<Outcome> {
	try {
		await fn();
		return { ok: true };
	} catch (e) {
		const err = e as Error;
		return { ok: false, name: err.name, message: err.message };
	}
}

interface SesInput {
	FromEmailAddress?: string;
	Destination?: { ToAddresses?: string[]; CcAddresses?: string[]; BccAddresses?: string[] };
	BulkEmailEntries?: unknown[];
}

/** Run `fn` against an AWS EmailClient whose SES client is stubbed; returns what reached SES. */
async function withAws<R>(options: EmailOptions, fn: (client: AwsEmailClient) => Promise<R>): Promise<{ result: R; sent: SesInput[] }> {
	const sent: SesInput[] = [];
	const send = mock.method(SESv2Client.prototype, 'send', async (cmd: { input: SesInput }) => {
		sent.push(cmd.input);
		if (cmd.input.BulkEmailEntries) {
			return { BulkEmailEntryResults: cmd.input.BulkEmailEntries.map((_, i) => ({ Status: 'SUCCESS', MessageId: `bulk-${i}` })) };
		}
		return { MessageId: 'ses-1' };
	});
	try {
		const client = new AwsEmailClient(new Scope('app'), uniqueId(), options);
		return { result: await fn(client), sent };
	} finally {
		send.mock.restore();
	}
}

const FROM = 'sender@example.com';
const msg = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({ to: 'user@example.com', subject: 's', body: 'b', ...overrides });
const addresses = (count: number) => Array.from({ length: count }, (_, i) => `user${i}@example.com`);

interface SendCase {
	label: string;
	options?: Partial<EmailOptions>;
	message: EmailMessage;
	/** `null` = success; otherwise the expected `EmailErrors` name. */
	error: string | null;
}

const sendCases: SendCase[] = [
	{ label: 'a valid message', message: msg(), error: null },
	{ label: 'a display-name recipient', message: msg({ to: 'Jane Doe <jane@example.com>' }), error: null },
	{ label: 'exactly 50 recipients across To, CC and BCC', message: msg({ to: addresses(30), cc: addresses(10), bcc: addresses(10) }), error: null },
	{ label: '51 recipients across To, CC and BCC', message: msg({ to: addresses(30), cc: addresses(11), bcc: addresses(10) }), error: EmailErrors.InvalidInput },
	{ label: 'a malformed To address', message: msg({ to: 'not-an-address' }), error: EmailErrors.InvalidInput },
	{ label: 'a To address with a CRLF header injection', message: msg({ to: 'user@example.com\r\nBcc: x@evil.test' }), error: EmailErrors.InvalidInput },
	{ label: 'a malformed CC address', message: msg({ cc: ['ok@example.com', 'bad@'] }), error: EmailErrors.InvalidInput },
	{ label: 'a malformed BCC address', message: msg({ bcc: ['bad address@example.com'] }), error: EmailErrors.InvalidInput },
	{ label: 'a malformed sender address', options: { fromAddress: 'sender@' }, message: msg(), error: EmailErrors.InvalidInput },
	{ label: 'a malformed reply-to address', options: { replyTo: ['reply@'] }, message: msg(), error: EmailErrors.InvalidInput },
	{
		// Order: addresses are checked before the recipient count, on both paths.
		label: 'too many recipients and a malformed one (address error wins)',
		message: msg({ to: [...addresses(60), 'bad@'] }),
		error: EmailErrors.InvalidInput,
	},
];

describe('EmailClient.send() validates the same input the same way on mock and AWS', () => {
	for (const c of sendCases) {
		test(c.label, async () => {
			const options: EmailOptions = { fromAddress: FROM, ...c.options };
			const mockOutcome = await outcomeOf(() => new MockEmailClient(new Scope('app'), uniqueId(), options).send(c.message));
			const { result: awsOutcome, sent } = await withAws(options, (client) => outcomeOf(() => client.send(c.message)));

			assert.deepStrictEqual(awsOutcome, mockOutcome, 'mock and AWS must reach the same outcome');
			if (c.error === null) {
				assert.deepStrictEqual(mockOutcome, { ok: true });
				assert.strictEqual(sent.length, 1, 'a valid message must reach SES exactly once');
				const to = Array.isArray(c.message.to) ? c.message.to : [c.message.to];
				assert.deepStrictEqual(sent[0].Destination?.ToAddresses, to);
				assert.strictEqual(sent[0].FromEmailAddress, options.fromAddress);
			} else {
				assert.strictEqual(mockOutcome.ok, false);
				assert.strictEqual(mockOutcome.ok === false && mockOutcome.name, c.error);
				assert.strictEqual(sent.length, 0, 'a rejected message must not reach SES');
			}
		});
	}

	test('the address error wins over the recipient count on both paths', async () => {
		const message = msg({ to: [...addresses(60), 'bad@'] });
		const outcome = await outcomeOf(() => new MockEmailClient(new Scope('app'), uniqueId(), { fromAddress: FROM }).send(message));
		assert.ok(outcome.ok === false && outcome.message.includes('Invalid email address'), JSON.stringify(outcome));
	});
});

describe('EmailClient.sendBatch() validates the same input the same way on mock and AWS', () => {
	test('a batch over maxBatchSize is rejected whole, before any send', async () => {
		const options: EmailOptions = { fromAddress: FROM, maxBatchSize: 2 };
		const batch = [msg(), msg(), msg()];
		const mockOutcome = await outcomeOf(() => new MockEmailClient(new Scope('app'), uniqueId(), options).sendBatch(batch));
		const { result: awsOutcome, sent } = await withAws(options, (client) => outcomeOf(() => client.sendBatch(batch)));

		assert.deepStrictEqual(awsOutcome, mockOutcome);
		assert.ok(mockOutcome.ok === false && mockOutcome.name === EmailErrors.InvalidInput);
		assert.strictEqual(sent.length, 0);
	});

	test('invalid entries fail with the same per-entry error, and only valid entries reach SES', async () => {
		const options: EmailOptions = { fromAddress: FROM };
		const batch = [msg({ to: 'a@example.com' }), msg({ to: 'bad@' }), msg({ to: addresses(51) }), msg({ to: 'b@example.com' })];
		const mockResult = await new MockEmailClient(new Scope('app'), uniqueId(), options).sendBatch(batch);
		const { result: awsResult, sent } = await withAws(options, (client) => client.sendBatch(batch));

		const shape = (r: typeof mockResult) => r.results.map((e) => ({ status: e.status, error: e.error }));
		assert.deepStrictEqual(shape(awsResult), shape(mockResult));
		assert.deepStrictEqual(shape(mockResult).map((e) => e.status), ['success', 'failed', 'failed', 'success']);
		assert.strictEqual(sent.length, 1, 'the two valid entries go out in one SendBulkEmail call');
		assert.strictEqual(sent[0].BulkEmailEntries?.length, 2);
	});
});
