// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the deployed (AWS) EmailClient with the SES client stubbed:
 * - it validates input exactly like the mock (shared `validation.ts`), so a
 *   message rejected locally is rejected when deployed, before any SES call;
 * - sendBatch() never places a plain-text body in an HTML part;
 * - a mapped `EmailErrors` error is branded, so its message crosses the RPC wire
 *   to the caller: it must be a stable, BB-authored string, never the raw SES text
 *   (which names identities, regions, configuration sets and account state). The
 *   SES error stays server-side on the non-enumerable `cause` and in the block's log.
 */
import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { inspect } from 'node:util';
import { Scope, isBlocksError, isWireSafeError } from '@aws-blocks/core';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { SESv2Client, SendBulkEmailCommand, type SendEmailCommand } from '@aws-sdk/client-sesv2';
import { EmailClient as AwsEmailClient, EmailErrors } from './index.aws.js';
import { EmailClient as MockEmailClient } from './index.mock.js';
import type { EmailMessage } from './types.js';

beforeEach(() => {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch {}
});

type Sent = SendEmailCommand | SendBulkEmailCommand;

interface StubOptions {
	fromAddress?: string;
	replyTo?: string[];
	/** Recipient (first To address) whose bulk entry SES reports as FAILED. */
	failEntryFor?: string;
	/** Throw from the whole SendBulkEmail call when it includes this recipient. */
	throwCallFor?: string;
}

/** An AWS EmailClient whose SES client records every command instead of calling SES. */
function awsClient(options: StubOptions | string = {}): { email: AwsEmailClient; sent: Sent[] } {
	const { fromAddress = 'noreply@example.com', replyTo, failEntryFor, throwCallFor } =
		typeof options === 'string' ? { fromAddress: options } : options;
	const email = new AwsEmailClient(new Scope('app'), 'mail', { fromAddress, replyTo });
	const sent: Sent[] = [];
	(email as unknown as { client: { send: (c: Sent) => Promise<unknown> } }).client.send = async (command: Sent) => {
		sent.push(command);
		if (command instanceof SendBulkEmailCommand) {
			const entries = command.input.BulkEmailEntries ?? [];
			const firstTo = (i: number) => entries[i].Destination?.ToAddresses?.[0];
			if (throwCallFor && entries.some((_, i) => firstTo(i) === throwCallFor)) {
				throw Object.assign(new Error('Maximum sending rate exceeded'), { name: 'TooManyRequestsException' });
			}
			return {
				BulkEmailEntryResults: entries.map((_, i) =>
					firstTo(i) === failEntryFor
						? { Status: 'FAILED', Error: 'Mailbox unavailable' }
						: { Status: 'SUCCESS', MessageId: `bulk-${sent.length}-${i}` },
				),
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
	{ label: 'a comma-separated list in one entry', message: { to: 'a@x.com, b <c@d.com>', subject: 's', body: 'b' }, error: EmailErrors.InvalidInput },
	{ label: 'a semicolon in the display name', message: { to: 'x;y <c@d.com>', subject: 's', body: 'b' }, error: EmailErrors.InvalidInput },
	{ label: 'surrounding whitespace', message: { to: ' a@b.com ', subject: 's', body: 'b' }, error: EmailErrors.InvalidInput },
	{ label: 'NEL (U+0085) in an address', message: { to: 'Jane\u0085Doe <a@b.com>', subject: 's', body: 'b' }, error: EmailErrors.InvalidInput },
	{ label: 'U+2028 in an address', message: { to: 'Jane\u2028Doe <a@b.com>', subject: 's', body: 'b' }, error: EmailErrors.InvalidInput },
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

for (const to of ['Jane Doe <jane@example.com>', '"Doe, Jane" <jane@example.com>']) {
	test(`send() accepts the display-name address ${to} on both the mock and AWS`, async () => {
		const message: EmailMessage = { to, subject: 's', body: 'b' };
		const mock = new MockEmailClient(new Scope('app'), 'mail', { fromAddress: 'Example <noreply@example.com>' });
		await mock.send(message);
		const { email, sent } = awsClient('Example <noreply@example.com>');
		await email.send(message);
		assert.strictEqual(sent.length, 1);
	});
}

test('send() rejects an invalid reply-to address on both the mock and AWS, without calling SES', async () => {
	const message: EmailMessage = { to: 'ok@example.com', subject: 's', body: 'b' };
	const mock = new MockEmailClient(new Scope('app'), 'mail', { fromAddress: 'noreply@example.com', replyTo: ['not-a-reply-to'] });
	await assert.rejects(() => mock.send(message), (e: unknown) => isBlocksError(e, EmailErrors.InvalidInput));
	const { email, sent } = awsClient({ replyTo: ['not-a-reply-to'] });
	await assert.rejects(() => email.send(message), (e: unknown) => isBlocksError(e, EmailErrors.InvalidInput));
	assert.strictEqual(sent.length, 0);
});

test('the error message escapes control characters instead of carrying them raw', async () => {
	const { email } = awsClient();
	await assert.rejects(
		() => email.send({ to: 'a@example.com\r\nBcc: x@example.com', subject: 's', body: 'b' }),
		(e: unknown) => {
			const message = (e as Error).message;
			assert.ok(!/[\r\n]/.test(message), `raw CR/LF in: ${JSON.stringify(message)}`);
			assert.ok(message.includes('\\r\\n'), 'the address is shown with escaped control characters');
			return true;
		},
	);
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

test('sendBatch() gives an entry that is invalid in two ways the same error on the mock and AWS', async () => {
	// More than 50 recipients AND a malformed address: both layers run the same
	// checks in the same order, so the first failing check names the error.
	const entry: EmailMessage = { to: [...fiftyOne, 'bad'], subject: 's', body: 'b' };
	const mock = new MockEmailClient(new Scope('app'), 'mail', { fromAddress: 'noreply@example.com' });
	const mockResult = await mock.sendBatch([entry]);
	const { email } = awsClient();
	const awsResult = await email.sendBatch([entry]);
	assert.strictEqual(mockResult.results[0].status, 'failed');
	assert.strictEqual(awsResult.results[0].status, 'failed');
	assert.strictEqual(mockResult.results[0].error, awsResult.results[0].error);
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
	// The html group is sent first (call 1), the text-only group second (call 2);
	// each result still carries the id of the entry it was sent as, in input order.
	assert.deepStrictEqual(results.map((r) => r.messageId), ['bulk-2-0', 'bulk-1-0', 'bulk-2-1']);
});

test('sendBatch() maps a FAILED bulk entry to its own input position', async () => {
	const { email } = awsClient({ failEntryFor: 'c@example.com' });
	const { results } = await email.sendBatch([
		{ to: 'a@example.com', subject: 'a', body: 'a' },
		{ to: 'b@example.com', subject: 'b', body: 'b', html: '<p>b</p>' },
		{ to: 'c@example.com', subject: 'c', body: 'c' },
	]);
	assert.deepStrictEqual(results, [
		{ status: 'success', messageId: 'bulk-2-0' },
		{ status: 'success', messageId: 'bulk-1-0' },
		{ status: 'failed', error: `${EmailErrors.SendFailed}: Email send failed (FAILED).` },
	]);
});

test('sendBatch() chunks 51 text-only + 1 html message into 3 calls with indices kept across the 50-entry boundary', async () => {
	const { email, sent } = awsClient();
	const messages: EmailMessage[] = Array.from({ length: 51 }, (_, i) => ({ to: `t${i}@example.com`, subject: 's', body: 'b' }));
	messages.splice(25, 0, { to: 'h@example.com', subject: 's', body: 'b', html: '<p>h</p>' });
	const { results } = await email.sendBatch(messages);

	const sizes = sent.map((c) => (c as SendBulkEmailCommand).input.BulkEmailEntries?.length);
	assert.deepStrictEqual(sizes, [1, 50, 1], 'html call, then text-only chunks of 50 and 1');
	assert.strictEqual(results[25].messageId, 'bulk-1-0', 'the html message keeps its input position');
	assert.strictEqual(results[0].messageId, 'bulk-2-0');
	assert.strictEqual(results[50].messageId, 'bulk-2-49', 'last entry of the first text-only chunk');
	assert.strictEqual(results[51].messageId, 'bulk-3-0', 'first entry of the second text-only chunk');
	assert.ok(results.every((r) => r.status === 'success'));
	const sentTo = sent.flatMap((c) => ((c as SendBulkEmailCommand).input.BulkEmailEntries ?? []).map((e) => e.Destination?.ToAddresses?.[0]));
	assert.strictEqual(new Set(sentTo).size, 52, 'every message sent exactly once');
});

test('sendBatch() marks only the failing call\'s messages failed when a whole SendBulkEmail call throws', async () => {
	const { email, sent } = awsClient({ throwCallFor: 'b@example.com' });
	const { results } = await email.sendBatch([
		{ to: 'a@example.com', subject: 'a', body: 'a' },
		{ to: 'b@example.com', subject: 'b', body: 'b', html: '<p>b</p>' },
		{ to: 'c@example.com', subject: 'c', body: 'c' },
	]);
	assert.strictEqual(sent.length, 2, 'the text-only group is still sent');
	assert.strictEqual(results[1].status, 'failed');
	assert.ok(results[1].error?.startsWith(EmailErrors.RateLimited), `expected a RateLimited message, got ${results[1].error}`);
	assert.deepStrictEqual([results[0], results[2]], [
		{ status: 'success', messageId: 'bulk-2-0' },
		{ status: 'success', messageId: 'bulk-2-1' },
	]);
});

const RAW_DETAIL = 'Email address is not verified. The following identities failed the check in region US-EAST-1: internal@corp.example (arn:aws:ses:us-east-1:123456789012:identity/corp.example)';

function sesError(name: string, message = RAW_DETAIL): Error {
	const err = new Error(message);
	err.name = name;
	Object.defineProperty(err, '$metadata', { value: { httpStatusCode: 400, requestId: 'req-1' }, enumerable: false });
	return err;
}

function recordingLogger(): { logger: ChildLogger; errors: unknown[] } {
	const errors: unknown[] = [];
	const logger: ChildLogger = {
		debug() {},
		info() {},
		warn() {},
		error(message, context) {
			// inspect() renders an Error's message, as the real logger does; JSON.stringify drops it.
			errors.push(inspect({ message, context }));
		},
		child: () => logger,
	};
	return { logger, errors };
}

let counter = 0;
function makeClient(logger?: ChildLogger): AwsEmailClient {
	return new AwsEmailClient(new Scope(`email-aws-${++counter}`), 'email', { fromAddress: 'noreply@example.com', logger });
}

afterEach(() => {
	mock.restoreAll();
});

describe('EmailClient.send error mapping (aws runtime)', () => {
	const cases: Array<{ sesName: string; expected: string }> = [
		{ sesName: 'MailFromDomainNotVerifiedException', expected: EmailErrors.DomainNotVerified },
		{ sesName: 'MessageRejected', expected: EmailErrors.DomainNotVerified },
		{ sesName: 'AccountSuspendedException', expected: EmailErrors.AccountPaused },
		{ sesName: 'SendingPausedException', expected: EmailErrors.AccountPaused },
		{ sesName: 'TooManyRequestsException', expected: EmailErrors.RateLimited },
		{ sesName: 'ThrottlingException', expected: EmailErrors.RateLimited },
		{ sesName: 'BadRequestException', expected: EmailErrors.InvalidInput },
		{ sesName: 'AccessDeniedException', expected: EmailErrors.SendFailed },
	];

	for (const { sesName, expected } of cases) {
		test(`${sesName} maps to ${expected} with a stable message and the SES error on cause`, async () => {
			const raw = sesError(sesName);
			mock.method(SESv2Client.prototype, 'send', async () => {
				throw raw;
			});
			const { logger, errors } = recordingLogger();
			const email = makeClient(logger);

			const thrown = await email.send({ to: 'user@example.com', subject: 's', body: 'b' }).then(
				() => assert.fail('send() should reject'),
				(err: unknown) => err,
			);

			assert.ok(isBlocksError(thrown, expected), `expected ${expected}, got ${String(thrown)}`);
			assert.ok(!thrown.message.includes('123456789012'), `message must not embed SES text: ${thrown.message}`);
			assert.ok(!thrown.message.includes('internal@corp.example'));
			assert.strictEqual(thrown.cause, raw, 'the SES error is kept as cause for server-side diagnostics');
			assert.ok(!Object.keys(thrown).includes('cause'), 'cause is non-enumerable (Core rule 5)');

			// Branded: the RPC serializer forwards this name AND message, so the
			// message checks above are exactly what the caller would see.
			assert.ok(isWireSafeError(thrown), 'the mapped error stays branded so its name crosses the wire');

			assert.ok(JSON.stringify(errors).includes(RAW_DETAIL), 'the SES error is logged server-side');
		});
	}
});

describe('EmailClient.sendBatch per-entry errors (aws runtime)', () => {
	test('a failed bulk entry reports a stable message, not the raw SES entry error', async () => {
		mock.method(SESv2Client.prototype, 'send', async () => ({
			BulkEmailEntryResults: [
				{ Status: 'SUCCESS', MessageId: 'm-1' },
				{ Status: 'CONFIGURATION_SET_DOES_NOT_EXIST', Error: `ConfigurationSet internal-cs does not exist (${RAW_DETAIL})` },
			],
		}));
		const { logger, errors } = recordingLogger();
		const email = makeClient(logger);

		const { results } = await email.sendBatch([
			{ to: 'a@example.com', subject: 's', body: 'b' },
			{ to: 'b@example.com', subject: 's', body: 'b' },
		]);

		assert.deepStrictEqual(results[0], { status: 'success', messageId: 'm-1' });
		assert.strictEqual(results[1].status, 'failed');
		assert.ok(results[1].error, 'a failed entry still reports an error');
		assert.ok(!results[1].error.includes('internal-cs'), `entry error must not embed SES text: ${results[1].error}`);
		assert.ok(!results[1].error.includes('123456789012'));
		assert.ok(JSON.stringify(errors).includes('internal-cs'), 'the raw entry error is logged server-side');
	});

	test('a whole-chunk SDK failure reports the mapped stable message on every entry', async () => {
		mock.method(SESv2Client.prototype, 'send', async () => {
			throw sesError('ThrottlingException');
		});
		const { logger, errors } = recordingLogger();
		const email = makeClient(logger);

		const { results } = await email.sendBatch([
			{ to: 'a@example.com', subject: 's', body: 'b' },
			{ to: 'b@example.com', subject: 's', body: 'b' },
		]);

		for (const r of results) {
			assert.strictEqual(r.status, 'failed');
			assert.ok(r.error?.startsWith(EmailErrors.RateLimited), `expected a RateLimited message, got ${r.error}`);
			assert.ok(!r.error?.includes('123456789012'), `entry error must not embed SES text: ${r.error}`);
		}
		assert.ok(JSON.stringify(errors).includes(RAW_DETAIL), 'the SES error is logged server-side');
	});
});
