// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS-runtime error mapping for EmailClient. A mapped `EmailErrors` error is
 * branded, so its message crosses the RPC wire to the caller: it must be a
 * stable, BB-authored string, never the raw SES text (which names identities,
 * regions, configuration sets and account state). The SES error stays
 * server-side on the non-enumerable `cause` and in the block's log.
 */

import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import { inspect } from 'node:util';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { Scope, isBlocksError, isWireSafeError } from '@aws-blocks/core';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { EmailClient, EmailErrors } from './index.aws.js';

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
function makeClient(logger?: ChildLogger): EmailClient {
	return new EmailClient(new Scope(`email-aws-${++counter}`), 'email', { fromAddress: 'noreply@example.com', logger });
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
