// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SESv2Client, SendEmailCommand, SendBulkEmailCommand } from '@aws-sdk/client-sesv2';
import { Scope, installClientUserAgent, blocksError } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { BB_NAME, BB_VERSION } from './version.js';

// Re-export public types and errors
export { EmailErrors } from './errors.js';
export type { EmailOptions, EmailMessage, SendResult, SendBatchResult } from './types.js';

import type { EmailOptions, EmailMessage, SendResult, SendBatchResult } from './types.js';
import { EmailErrors } from './errors.js';
import { validateMessage } from './validation.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';

const BATCH_CHUNK_SIZE = 50;

/**
 * Map an SES SDK error to a branded `EmailErrors` error.
 *
 * Every branch uses a STABLE, BB-authored message — never the raw SES
 * `err.message`. A branded message crosses the RPC wire to the caller, and SES
 * text names identities, regions, configuration sets and account state. The SES
 * error is kept on the non-enumerable `cause` (so `JSON.stringify` cannot leak
 * its `$metadata`) and is logged by the caller.
 */
function mapSesError(err: unknown): Error {
	const name = err instanceof Error ? err.name : '';
	const rawMessage = err instanceof Error ? err.message : String(err);

	let mapped: Error;
	if (name === 'MailFromDomainNotVerifiedException') {
		mapped = blocksError(EmailErrors.DomainNotVerified, 'The sending domain or address is not verified in SES.');
	} else if (name === 'MessageRejected') {
		// The raw text is only inspected to pick the code; it never reaches the message.
		const lower = rawMessage.toLowerCase();
		mapped = lower.includes('not verified') || lower.includes('identity')
			? blocksError(EmailErrors.DomainNotVerified, 'The sending domain or address is not verified in SES.')
			: blocksError(EmailErrors.SendFailed, 'SES rejected the message.');
	} else if (name === 'AccountSuspendedException' || name === 'SendingPausedException') {
		mapped = blocksError(EmailErrors.AccountPaused, 'Email sending is paused for this account.');
	} else if (name === 'TooManyRequestsException' || name === 'ThrottlingException') {
		mapped = blocksError(EmailErrors.RateLimited, 'SES rate limit exceeded. Retry after a backoff.');
	} else if (name === 'BadRequestException') {
		mapped = blocksError(EmailErrors.InvalidInput, 'SES rejected the request as invalid.');
	} else {
		mapped = blocksError(EmailErrors.SendFailed, 'Email send failed.');
	}
	Object.defineProperty(mapped, 'cause', { value: err, enumerable: false, writable: true, configurable: true });
	return mapped;
}

/**
 * Send transactional emails via Amazon SES.
 *
 * **When to use:** You need to send transactional emails (welcome messages,
 * password resets, notifications, order confirmations).
 *
 * **When NOT to use:** For bulk marketing campaigns, use a dedicated ESP.
 * For in-app notifications, use a notification service.
 *
 * **Best practices:**
 * - Verify your sending domain in SES before production use
 * - Use a configuration set for delivery tracking
 * - Keep email content under 40 MB
 * - Each message is limited to 50 recipients (To + CC + BCC combined)
 *
 * **Scaling:** SES handles up to 200 emails/second by default (can request increase).
 * No infrastructure to manage.
 */
export class EmailClient extends Scope {
	private client: SESv2Client;
	private fromAddress: string;
	private replyTo?: string[];
	private configurationSet?: string;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options: EmailOptions) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this.client = new SESv2Client({
			maxAttempts: 3,
			customUserAgent: this.buildUserAgentChain(),
		});
		installClientUserAgent(this.client);
		this.fromAddress = options.fromAddress;
		this.replyTo = options.replyTo;
		this.configurationSet = options.configurationSet;
	}

	/**
	 * Send an email to one or more recipients.
	 *
	 * Uses the SDK's built-in adaptive retry with maxAttempts: 3.
	 *
	 * Thrown errors carry a stable, BB-authored message (the caller may forward it to a client);
	 * the raw SES error is logged and kept on the non-enumerable `cause`.
	 *
	 * @param message - The email message to send (to, subject, body, optional html/cc/bcc).
	 * @returns The SES message ID for the sent email.
	 * @throws {EmailErrors.SendFailed} General send failure.
	 * @throws {EmailErrors.InvalidInput} If input is invalid (e.g. malformed address, too many recipients).
	 * @throws {EmailErrors.DomainNotVerified} If the sending domain is not verified.
	 * @throws {EmailErrors.AccountPaused} If account sending is paused.
	 * @throws {EmailErrors.RateLimited} If rate limit is exceeded.
	 */
	async send(message: EmailMessage): Promise<SendResult> {
		const { to, subject, body, html, cc, bcc } = message;
		// Same checks as the mock, so local and deployed accept the same input.
		validateMessage(message, this.fromAddress, this.replyTo);
		const recipients = Array.isArray(to) ? to : [to];

		const command = new SendEmailCommand({
			FromEmailAddress: this.fromAddress,
			Destination: {
				ToAddresses: recipients,
				...(cc?.length ? { CcAddresses: cc } : {}),
				...(bcc?.length ? { BccAddresses: bcc } : {}),
			},
			...(this.replyTo && { ReplyToAddresses: this.replyTo }),
			Content: {
				Simple: {
					Subject: { Data: subject },
					Body: {
						Text: { Data: body },
						...(html ? { Html: { Data: html } } : {}),
					},
				},
			},
			...(this.configurationSet ? { ConfigurationSetName: this.configurationSet } : {}),
		});

		try {
			const response = await this.client.send(command);
			return { messageId: response.MessageId ?? '' };
		} catch (err) {
			if (err instanceof Error && err.name in EmailErrors) throw err;
			this.log.error('SES SendEmail failed', { error: err });
			throw mapSesError(err);
		}
	}

	/**
	 * Send a batch of email messages using the SES SendBulkEmail API with inline passthrough templates.
	 *
	 * Messages are chunked into groups of 50 destinations per API call (SES limit).
	 *
	 * TODO: Add retry logic for transient failures (throttling, 5xx).
	 *
	 * @param messages - Array of email messages to send.
	 * @returns Result with per-message status in the same order as the input array. A failed
	 *   entry's `error` is a stable message naming the `EmailErrors` code or SES entry status;
	 *   the raw SES error text is logged server-side, not returned.
	 */
	async sendBatch(messages: EmailMessage[]): Promise<SendBatchResult> {
		const results: Array<{ status: 'success' | 'failed'; messageId?: string; error?: string }> =
			new Array(messages.length);

		// Validate each entry the way send() and the mock do. An invalid entry is
		// marked failed and never reaches SES, matching the mock's per-entry status.
		const withHtml: number[] = [];
		const textOnly: number[] = [];
		for (let i = 0; i < messages.length; i++) {
			try {
				validateMessage(messages[i], this.fromAddress, this.replyTo);
			} catch (err: any) {
				results[i] = { status: 'failed', error: err.message ?? 'Invalid message' };
				continue;
			}
			(messages[i].html ? withHtml : textOnly).push(i);
		}

		// A SendBulkEmail call shares one template across its entries. Messages
		// without `html` go through a text-only template, so their plain-text body
		// is never placed in an HTML part where a mail client would render it as
		// markup. This matches send(), which adds an HTML part only when `html` is set.
		for (const [indices, withHtmlPart] of [[withHtml, true], [textOnly, false]] as const) {
			for (let chunkStart = 0; chunkStart < indices.length; chunkStart += BATCH_CHUNK_SIZE) {
				const chunkIndices = indices.slice(chunkStart, chunkStart + BATCH_CHUNK_SIZE);
				await this.sendBulkChunk(messages, chunkIndices, withHtmlPart, results);
			}
		}

		return { results };
	}

	/** Send one SendBulkEmail call (at most 50 entries) and record each entry's result by input index. */
	private async sendBulkChunk(
		messages: EmailMessage[],
		chunkIndices: number[],
		withHtmlPart: boolean,
		results: Array<{ status: 'success' | 'failed'; messageId?: string; error?: string }>,
	): Promise<void> {
		const command = new SendBulkEmailCommand({
			FromEmailAddress: this.fromAddress,
			...(this.replyTo && { ReplyToAddresses: this.replyTo }),
			...(this.configurationSet ? { ConfigurationSetName: this.configurationSet } : {}),
			DefaultContent: {
				Template: {
					TemplateContent: {
						Subject: '{{subject}}',
						Text: '{{body}}',
						...(withHtmlPart ? { Html: '{{html}}' } : {}),
					},
					TemplateData: JSON.stringify(withHtmlPart ? { subject: '', body: '', html: '' } : { subject: '', body: '' }),
				},
			},
			BulkEmailEntries: chunkIndices.map((idx) => {
				const msg = messages[idx];
				return {
					Destination: {
						ToAddresses: Array.isArray(msg.to) ? msg.to : [msg.to],
						CcAddresses: msg.cc || [],
						BccAddresses: msg.bcc || [],
					},
					ReplacementEmailContent: {
						ReplacementTemplate: {
							ReplacementTemplateData: JSON.stringify({
								subject: msg.subject,
								body: msg.body,
								...(withHtmlPart ? { html: msg.html } : {}),
							}),
						},
					},
				};
			}),
		});

		try {
			const response = await this.client.send(command);
			const bulkResults = response.BulkEmailEntryResults ?? [];

			for (let i = 0; i < chunkIndices.length; i++) {
				const globalIdx = chunkIndices[i];
				const entry = bulkResults[i];

				if (entry?.Status === 'SUCCESS') {
					results[globalIdx] = { status: 'success', messageId: entry.MessageId ?? '' };
				} else {
					// SES entry `Error` text can name configuration sets and identities: log it,
					// return only the SES status enum.
					this.log.error('SES bulk entry failed', { index: globalIdx, status: entry?.Status, error: entry?.Error });
					results[globalIdx] = { status: 'failed', error: `${EmailErrors.SendFailed}: Email send failed (${entry?.Status ?? 'no result'}).` };
				}
			}
		} catch (err: any) {
			// Entire chunk failed — mark all as failed
			this.log.error('SES SendBulkEmail failed', { error: err });
			const mapped = mapSesError(err);
			for (const globalIdx of chunkIndices) {
				results[globalIdx] = { status: 'failed', error: mapped.message };
			}
		}
	}
}
