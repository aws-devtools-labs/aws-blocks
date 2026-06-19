// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope } from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import type { ScopeParent } from '@aws-blocks/core';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BB_NAME, BB_VERSION } from './version.js';

// ── Public types ────────────────────────────────────────────────────────────

export {
	SmsErrors,
} from './errors.js';
export type {
	SmsOptions,
	SmsMessage,
	PushMessage,
	SmsType,
	SendResult,
	SendBatchResult,
} from './types.js';

import type { SmsOptions, SmsMessage, PushMessage, SmsType, SendResult, SendBatchResult } from './types.js';
import { SmsErrors } from './errors.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';

// ── Helpers ─────────────────────────────────────────────────────────────────

const MAX_SMS_BYTES = 1600; // SNS multi-part SMS upper bound
const LOG_TRUNCATE_LENGTH = 80;

// E.164: a leading '+' followed by 1–15 digits, the first of which is non-zero.
const E164_REGEX = /^\+[1-9]\d{1,14}$/;
// SNS resource ARN (topic or platform endpoint).
const SNS_ARN_REGEX = /^arn:aws[a-z-]*:sns:[a-z0-9-]+:\d{12}:.+/i;

function truncate(text: string, maxLen: number = LOG_TRUNCATE_LENGTH): string {
	const oneLine = text.replace(/\n/g, ' ').trim();
	if (oneLine.length <= maxLen) return oneLine;
	return oneLine.substring(0, maxLen) + '...';
}

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

function validatePhoneNumber(to: string): void {
	if (!E164_REGEX.test(to)) {
		throw blocksError(
			SmsErrors.InvalidInput,
			`Invalid phone number "${to}". Use E.164 format, e.g. +14155550123.`,
		);
	}
}

function validateBody(body: string): void {
	if (body.length === 0) {
		throw blocksError(SmsErrors.InvalidInput, 'Message body must not be empty.');
	}
	const size = Buffer.byteLength(body, 'utf8');
	if (size > MAX_SMS_BYTES) {
		throw blocksError(
			SmsErrors.InvalidInput,
			`Message body ${size} bytes exceeds the ${MAX_SMS_BYTES}-byte SMS limit.`,
		);
	}
}

function validatePushTarget(target: string): void {
	if (!SNS_ARN_REGEX.test(target)) {
		throw blocksError(
			SmsErrors.InvalidTarget,
			`Invalid push target "${target}". Expected an SNS endpoint or topic ARN.`,
		);
	}
}

function generateMockMessageId(): string {
	return `mock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface StoredMessage {
	kind: 'sms' | 'push';
	to?: string;
	target?: string;
	body: string;
	title?: string;
	smsType?: SmsType;
	senderId?: string;
	messageId: string;
	timestamp: string;
}

// ── SmsClient (mock) ──────────────────────────────────────────────────────────

/**
 * Send transactional SMS and mobile push notifications via Amazon SNS.
 *
 * **When to use:** You need to send one-time passwords, delivery alerts, or
 * mobile push notifications to phone numbers or registered devices.
 *
 * **When NOT to use:** For email, use `EmailClient`. For in-app real-time
 * messages to connected browser clients, use `Realtime`.
 *
 * **Best practices:**
 * - Use E.164 phone numbers (`+14155550123`)
 * - Prefer `Transactional` SMS for OTPs and critical alerts
 * - For mobile push, register devices to an SNS platform application and pass
 *   the endpoint ARN as the `target`
 *
 * **Scaling:** SNS handles SMS and push fan-out with no infrastructure to
 * manage. SMS throughput is governed by your account's spend limit and
 * origination identities.
 *
 * In local development, messages are logged to the console and persisted to
 * `.bb-data/{id}/messages.json` — no AWS account or phone delivery occurs.
 */
export class SmsClient extends Scope {
	private filePath: string;
	private messages: StoredMessage[];
	private senderId?: string;
	private smsType: SmsType;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options: SmsOptions = {}) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this.senderId = options.senderId;
		this.smsType = options.smsType ?? 'Transactional';
		this.filePath = join(getMockDataDir(this), 'messages.json');
		this.messages = this.loadFromDisk();
	}

	/**
	 * Send an SMS to a single phone number.
	 *
	 * @param message - The SMS message (to, body, optional senderId/smsType).
	 * @returns The mock message ID for the sent SMS.
	 * @throws {SmsErrors.InvalidInput} If the phone number is not E.164 or the body is empty / too large.
	 */
	async send(message: SmsMessage): Promise<SendResult> {
		const { to, body } = message;
		validatePhoneNumber(to);
		validateBody(body);

		const smsType = message.smsType ?? this.smsType;
		const senderId = message.senderId ?? this.senderId;
		const messageId = generateMockMessageId();

		const lines = [
			`[Sms:${this.id}]`,
			`  To:        ${to}`,
			`  Type:      ${smsType}`,
			`  Body:      ${truncate(body)}`,
		];
		if (senderId) lines.push(`  SenderId:  ${senderId}`);
		console.log(lines.join('\n'));

		this.messages.push({
			kind: 'sms',
			to,
			body,
			smsType,
			senderId,
			messageId,
			timestamp: new Date().toISOString(),
		});
		this.flushToDisk();

		return { messageId };
	}

	/**
	 * Send a batch of SMS messages.
	 *
	 * SNS has no bulk SMS API, so messages are sent individually. A failure on
	 * one message does not abort the batch; failures are reported per-entry
	 * rather than thrown.
	 *
	 * @param messages - Array of SMS messages to send.
	 * @returns Result with per-message status in the same order as the input array.
	 */
	async sendBatch(messages: SmsMessage[]): Promise<SendBatchResult> {
		const results: SendBatchResult['results'] = [];
		for (const msg of messages) {
			try {
				const { messageId } = await this.send(msg);
				results.push({ status: 'success', messageId });
			} catch (err: any) {
				results.push({ status: 'failed', error: err.message ?? 'Unknown error' });
			}
		}
		return { results };
	}

	/**
	 * Send a mobile push notification to an SNS platform endpoint or topic.
	 *
	 * @param message - The push message (target ARN, body, optional title/data/badge).
	 * @returns The mock message ID for the published notification.
	 * @throws {SmsErrors.InvalidTarget} If the target is not a valid SNS ARN.
	 * @throws {SmsErrors.InvalidInput} If the body is empty.
	 */
	async push(message: PushMessage): Promise<SendResult> {
		const { target, body, title } = message;
		validatePushTarget(target);
		if (body.length === 0) {
			throw blocksError(SmsErrors.InvalidInput, 'Message body must not be empty.');
		}

		const messageId = generateMockMessageId();
		const lines = [
			`[Push:${this.id}]`,
			`  Target:    ${target}`,
		];
		if (title) lines.push(`  Title:     ${truncate(title)}`);
		lines.push(`  Body:      ${truncate(body)}`);
		console.log(lines.join('\n'));

		this.messages.push({
			kind: 'push',
			target,
			body,
			title,
			messageId,
			timestamp: new Date().toISOString(),
		});
		this.flushToDisk();

		return { messageId };
	}

	// ── Disk persistence ──────────────────────────────────────────────────

	private loadFromDisk(): StoredMessage[] {
		if (!existsSync(this.filePath)) return [];
		try {
			return JSON.parse(readFileSync(this.filePath, 'utf8'));
		} catch {
			return [];
		}
	}

	private flushToDisk(): void {
		writeFileSync(this.filePath, JSON.stringify(this.messages, null, 2));
	}
}
