// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, brandBlocksError } from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import type { ScopeParent } from '@aws-blocks/core';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BB_NAME, BB_VERSION } from './version.js';

// ── Public types ────────────────────────────────────────────────────────────

export {
	EmailErrors,
} from './errors.js';
export type {
	EmailOptions,
	EmailMessage,
	SendResult,
	SendBatchResult,
} from './types.js';

import type { EmailOptions, EmailMessage, SendResult, SendBatchResult } from './types.js';
import { EmailErrors } from './errors.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';

// ── Helpers ─────────────────────────────────────────────────────────────────

const MAX_RECIPIENTS_PER_MESSAGE = 50;
const MAX_MESSAGE_BYTES = 40 * 1024 * 1024; // 40 MB
const LOG_TRUNCATE_LENGTH = 80;

function truncate(text: string, maxLen: number = LOG_TRUNCATE_LENGTH): string {
	const oneLine = text.replace(/\n/g, ' ').trim();
	if (oneLine.length <= maxLen) return oneLine;
	return oneLine.substring(0, maxLen) + '...';
}

// Basic RFC 5322 email regex
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return brandBlocksError(err);
}

function validateEmailAddress(address: string): void {
	if (!EMAIL_REGEX.test(address)) {
		throw blocksError(EmailErrors.InvalidInput, `Invalid email address: ${address}`);
	}
}

function validateAddresses(addresses: string | string[]): void {
	const list = Array.isArray(addresses) ? addresses : [addresses];
	for (const addr of list) {
		validateEmailAddress(addr);
	}
}

function countRecipients(msg: { to: string | string[]; cc?: string[]; bcc?: string[] }): number {
	const toCount = Array.isArray(msg.to) ? msg.to.length : 1;
	const ccCount = msg.cc?.length ?? 0;
	const bccCount = msg.bcc?.length ?? 0;
	return toCount + ccCount + bccCount;
}

function validateRecipientCount(msg: { to: string | string[]; cc?: string[]; bcc?: string[] }): void {
	const count = countRecipients(msg);
	if (count > MAX_RECIPIENTS_PER_MESSAGE) {
		throw blocksError(
			EmailErrors.InvalidInput,
			`Recipient count exceeds ${MAX_RECIPIENTS_PER_MESSAGE}.`,
		);
	}
}

function generateMockMessageId(): string {
	return `mock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface StoredEmail {
	to: string | string[];
	subject: string;
	body: string;
	html?: string;
	from: string;
	messageId: string;
	timestamp: string;
}

// ── Email (mock) ────────────────────────────────────────────────────────────

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
 * - Batch sends use the SES SendBulkEmail API (max 50 destinations per API call)
 *
 * **Scaling:** SES handles up to 200 emails/second by default (can request increase).
 * No infrastructure to manage.
 */
export class EmailClient extends Scope {
	private filePath: string;
	private emails: StoredEmail[];
	private fromAddress: string;
	private replyTo?: string[];

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options: EmailOptions) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this.fromAddress = options.fromAddress;
		this.replyTo = options.replyTo;
		this.filePath = join(getMockDataDir(this), 'emails.json');
		this.emails = this.loadFromDisk();
	}

	/**
	 * Send an email to one or more recipients.
	 *
	 * @param message - The email message to send (to, subject, body, optional html/cc/bcc).
	 * @returns The mock message ID for the sent email.
	 * @throws {EmailErrors.InvalidInput} If any address fails validation.
	 * @throws {EmailErrors.SendFailed} If the message exceeds 40 MB or recipient count exceeds 50.
	 */
	async send(message: EmailMessage): Promise<SendResult> {
		const { to, subject, body, html, cc, bcc } = message;

		validateAddresses(to);
		validateEmailAddress(this.fromAddress);
		if (cc) validateAddresses(cc);
		if (bcc) validateAddresses(bcc);

		validateRecipientCount({ to, cc, bcc });

		const messageSize = Buffer.byteLength(
			JSON.stringify(message),
			'utf8',
		);
		if (messageSize > MAX_MESSAGE_BYTES) {
			throw blocksError(EmailErrors.SendFailed, `Message size ${messageSize} bytes exceeds the 40 MB limit`);
		}

		const recipients = Array.isArray(to) ? to : [to];
		const messageId = generateMockMessageId();
		const lines = [
			`[Email:${this.id}]`,
			`  Recipient: ${recipients.join(', ')}`,
			`  Subject:   ${subject}`,
			`  Body:      ${truncate(body)}`,
		];
		if (html) {
			lines.push(`  HTML:      ${truncate(html)}`);
		}
		console.log(lines.join('\n'));

		const stored: StoredEmail = {
			to,
			subject,
			body,
			html,
			from: this.fromAddress,
			messageId,
			timestamp: new Date().toISOString(),
		};
		this.emails.push(stored);
		this.flushToDisk();

		return { messageId };
	}

	/**
	 * Send a batch of email messages.
	 *
	 * Each individual message must not exceed 50 recipients (To + CC + BCC combined).
	 * Messages exceeding this limit are marked as failed in the results (not thrown).
	 * This matches SES SendBulkEmail behavior which returns per-entry status.
	 *
	 * @param messages - Array of email messages to send.
	 * @returns Result with per-message status in the same order as the input array.
	 *          Each entry has status ('success' | 'failed'), messageId (on success), or error (on failure).
	 */
	async sendBatch(messages: EmailMessage[]): Promise<SendBatchResult> {
		const results: Array<{ status: 'success' | 'failed'; messageId?: string; error?: string }> = [];

		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (countRecipients(msg) > MAX_RECIPIENTS_PER_MESSAGE) {
				results.push({ status: 'failed', error: `Recipient count exceeds ${MAX_RECIPIENTS_PER_MESSAGE}.` });
				continue;
			}
			try {
				const sendResult = await this.send(msg);
				results.push({ status: 'success', messageId: sendResult.messageId });
			} catch (err: any) {
				results.push({ status: 'failed', error: err.message ?? 'Unknown error' });
			}
		}

		return { results };
	}

	// ── Disk persistence ──────────────────────────────────────────────────

	private loadFromDisk(): StoredEmail[] {
		if (!existsSync(this.filePath)) return [];
		try {
			return JSON.parse(readFileSync(this.filePath, 'utf8'));
		} catch {
			return [];
		}
	}

	private flushToDisk(): void {
		writeFileSync(this.filePath, JSON.stringify(this.emails, null, 2));
	}
}
