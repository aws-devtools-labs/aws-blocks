// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { Scope } from '@aws-blocks/core';
import { SESv2Client, SendBulkEmailCommand, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { BB_NAME, BB_VERSION } from './version.js';

// Re-export public types and errors
export { EmailErrors } from './errors.js';
export type { EmailMessage, EmailOptions, SendBatchResult, SendResult } from './types.js';

import type { ChildLogger } from '@aws-blocks/bb-logger';
import { Logger } from '@aws-blocks/bb-logger';
import { EmailErrors } from './errors.js';
import type { EmailMessage, EmailOptions, SendBatchResult, SendResult } from './types.js';

const BATCH_CHUNK_SIZE = 50;
const BATCH_MAX_ATTEMPTS = 3;

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

function mapSesError(err: any): Error {
	const message = err.message ?? 'Unknown SES error';

	if (err.name === 'MailFromDomainNotVerifiedException') {
		return blocksError(EmailErrors.DomainNotVerified, message);
	}

	if (err.name === 'MessageRejected') {
		const lower = message.toLowerCase();
		if (lower.includes('not verified') || lower.includes('identity')) {
			return blocksError(EmailErrors.DomainNotVerified, message);
		}
		return blocksError(EmailErrors.SendFailed, message);
	}

	if (err.name === 'AccountSuspendedException' || err.name === 'SendingPausedException') {
		return blocksError(EmailErrors.AccountPaused, message);
	}

	if (err.name === 'TooManyRequestsException' || err.name === 'ThrottlingException') {
		return blocksError(EmailErrors.RateLimited, message);
	}

	if (err.name === 'BadRequestException') {
		return blocksError(EmailErrors.InvalidInput, message);
	}

	return blocksError(EmailErrors.SendFailed, message);
}

function isTransientSesError(err: any): boolean {
	if (err?.$retryable) return true;
	if (typeof err?.$metadata?.httpStatusCode === 'number' && err.$metadata.httpStatusCode >= 500) return true;

	return [
		'TooManyRequestsException',
		'ThrottlingException',
		'RequestTimeout',
		'RequestTimeoutException',
		'ServiceUnavailableException',
		'InternalFailure',
		'InternalServerException',
	].includes(err?.name);
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
		this.fromAddress = options.fromAddress;
		this.replyTo = options.replyTo;
		this.configurationSet = options.configurationSet;
	}

	/**
	 * Send an email to one or more recipients.
	 *
	 * Uses the SDK's built-in adaptive retry with maxAttempts: 3.
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
		} catch (err: any) {
			if (err.name && err.name in EmailErrors) throw err;
			throw mapSesError(err);
		}
	}

	/**
	 * Send a batch of email messages using the SES SendBulkEmail API with inline passthrough templates.
	 *
	 * Messages are chunked into groups of 50 destinations per API call (SES limit).
	 *
	 * @param messages - Array of email messages to send.
	 * @returns Result with per-message status in the same order as the input array.
	 */
	async sendBatch(messages: EmailMessage[]): Promise<SendBatchResult> {
		const results: Array<{ status: 'success' | 'failed'; messageId?: string; error?: string }> = new Array(
			messages.length,
		);

		// Process in chunks of BATCH_CHUNK_SIZE
		for (let chunkStart = 0; chunkStart < messages.length; chunkStart += BATCH_CHUNK_SIZE) {
			const chunkIndices = messages
				.slice(chunkStart, chunkStart + BATCH_CHUNK_SIZE)
				.map((_, i) => chunkStart + i);
			const chunk = chunkIndices.map((idx) => messages[idx]);

			const command = new SendBulkEmailCommand({
				FromEmailAddress: this.fromAddress,
				...(this.replyTo && { ReplyToAddresses: this.replyTo }),
				...(this.configurationSet ? { ConfigurationSetName: this.configurationSet } : {}),
				DefaultContent: {
					Template: {
						TemplateContent: {
							Subject: '{{subject}}',
							Html: '{{html}}',
							Text: '{{body}}',
						},
						TemplateData: JSON.stringify({ subject: '', body: '', html: '' }),
					},
				},
				BulkEmailEntries: chunk.map((msg) => ({
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
								...(msg.html ? { html: msg.html } : { html: msg.body }),
							}),
						},
					},
				})),
			});

			try {
				const response = await this.sendBulkWithRetry(command);
				const bulkResults = response.BulkEmailEntryResults ?? [];

				for (let i = 0; i < chunkIndices.length; i++) {
					const globalIdx = chunkIndices[i];
					const entry = bulkResults[i];

					if (entry?.Status === 'SUCCESS') {
						results[globalIdx] = { status: 'success', messageId: entry.MessageId ?? '' };
					} else {
						const errorMsg = entry?.Error ?? 'Unknown bulk send error';
						results[globalIdx] = { status: 'failed', error: errorMsg };
					}
				}
			} catch (err: any) {
				// Entire chunk failed — mark all as failed
				for (const globalIdx of chunkIndices) {
					const mapped = mapSesError(err);
					results[globalIdx] = { status: 'failed', error: mapped.message };
				}
			}
		}

		return { results };
	}

	private async sendBulkWithRetry(command: SendBulkEmailCommand) {
		let lastError: unknown;

		for (let attempt = 1; attempt <= BATCH_MAX_ATTEMPTS; attempt++) {
			try {
				return await this.client.send(command);
			} catch (err: any) {
				lastError = err;
				if (attempt >= BATCH_MAX_ATTEMPTS || !isTransientSesError(err)) {
					throw err;
				}
			}
		}

		throw lastError;
	}
}
