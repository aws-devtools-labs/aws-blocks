// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import type { PublishCommandInput } from '@aws-sdk/client-sns';
import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { BB_NAME, BB_VERSION } from './version.js';

// Re-export public types and errors
export { SmsErrors } from './errors.js';
export type { SmsOptions, SmsMessage, PushMessage, SmsType, SendResult, SendBatchResult } from './types.js';

import type { SmsOptions, SmsMessage, PushMessage, SmsType, SendResult, SendBatchResult } from './types.js';
import { SmsErrors } from './errors.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

function mapSnsError(err: any): Error {
	const message = err.message ?? 'Unknown SNS error';

	switch (err.name) {
		case 'EndpointDisabledException':
		case 'PlatformApplicationDisabledException':
			return blocksError(SmsErrors.OptedOut, message);
		case 'InvalidParameterException':
		case 'InvalidParameterValueException':
			// SNS reports both malformed phone numbers and unknown ARNs here;
			// disambiguate on the message so callers can branch on the cause.
			return /arn/i.test(message)
				? blocksError(SmsErrors.InvalidTarget, message)
				: blocksError(SmsErrors.InvalidInput, message);
		case 'NotFoundException':
			return blocksError(SmsErrors.InvalidTarget, message);
		case 'ThrottledException':
		case 'ThrottlingException':
		case 'TooManyRequestsException':
			return blocksError(SmsErrors.RateLimited, message);
		default:
			return blocksError(SmsErrors.SendFailed, message);
	}
}

/**
 * Build the SNS message attributes that carry SMS sender ID and delivery class.
 */
function smsAttributes(smsType: SmsType, senderId?: string): PublishCommandInput['MessageAttributes'] {
	const attrs: NonNullable<PublishCommandInput['MessageAttributes']> = {
		'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: smsType },
	};
	if (senderId) {
		attrs['AWS.SNS.SMS.SenderID'] = { DataType: 'String', StringValue: senderId };
	}
	return attrs;
}

/**
 * Build the SNS publish payload for a push notification. When a title, data
 * payload, or badge is supplied, a platform-specific JSON message structure is
 * emitted so APNS and FCM render a rich notification; otherwise a plain default
 * message is sent.
 */
function buildPushPayload(message: PushMessage): Pick<PublishCommandInput, 'Message' | 'MessageStructure'> {
	const { body, title, data, badge } = message;
	const isRich = title !== undefined || data !== undefined || badge !== undefined;
	if (!isRich) {
		return { Message: body };
	}

	const gcm = {
		notification: { ...(title !== undefined ? { title } : {}), body },
		...(data ? { data } : {}),
	};
	const apns = {
		aps: {
			alert: { ...(title !== undefined ? { title } : {}), body },
			...(badge !== undefined ? { badge } : {}),
		},
		...(data ?? {}),
	};

	return {
		Message: JSON.stringify({
			default: body,
			GCM: JSON.stringify(gcm),
			APNS: JSON.stringify(apns),
			APNS_SANDBOX: JSON.stringify(apns),
		}),
		MessageStructure: 'json',
	};
}

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
 */
export class SmsClient extends Scope {
	private client: SNSClient;
	private senderId?: string;
	private smsType: SmsType;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options: SmsOptions = {}) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this.client = new SNSClient({
			maxAttempts: 3,
			customUserAgent: this.buildUserAgentChain(),
		});
		this.senderId = options.senderId;
		this.smsType = options.smsType ?? 'Transactional';
	}

	/**
	 * Send an SMS to a single phone number.
	 *
	 * Uses the SDK's built-in adaptive retry with maxAttempts: 3.
	 *
	 * @param message - The SMS message (to, body, optional senderId/smsType).
	 * @returns The SNS message ID for the sent SMS.
	 * @throws {SmsErrors.SendFailed} General send failure.
	 * @throws {SmsErrors.InvalidInput} If the phone number or body is rejected by SNS.
	 * @throws {SmsErrors.OptedOut} If the recipient has opted out.
	 * @throws {SmsErrors.RateLimited} If the SNS request was throttled.
	 */
	async send(message: SmsMessage): Promise<SendResult> {
		const smsType = message.smsType ?? this.smsType;
		const senderId = message.senderId ?? this.senderId;

		const command = new PublishCommand({
			PhoneNumber: message.to,
			Message: message.body,
			MessageAttributes: smsAttributes(smsType, senderId),
		});

		try {
			const response = await this.client.send(command);
			return { messageId: response.MessageId ?? '' };
		} catch (err: any) {
			if (err.name && err.name in SmsErrors) throw err;
			throw mapSnsError(err);
		}
	}

	/**
	 * Send a batch of SMS messages.
	 *
	 * SNS has no bulk SMS API, so messages are published individually. A failure
	 * on one message does not abort the batch; failures are reported per-entry
	 * rather than thrown.
	 *
	 * @param messages - Array of SMS messages to send.
	 * @returns Result with per-message status in the same order as the input array.
	 */
	async sendBatch(messages: SmsMessage[]): Promise<SendBatchResult> {
		const results: SendBatchResult['results'] = new Array(messages.length);
		for (let i = 0; i < messages.length; i++) {
			try {
				const { messageId } = await this.send(messages[i]);
				results[i] = { status: 'success', messageId };
			} catch (err: any) {
				results[i] = { status: 'failed', error: err.message ?? 'Unknown error' };
			}
		}
		return { results };
	}

	/**
	 * Send a mobile push notification to an SNS platform endpoint or topic.
	 *
	 * @param message - The push message (target ARN, body, optional title/data/badge).
	 * @returns The SNS message ID for the published notification.
	 * @throws {SmsErrors.InvalidTarget} If the target ARN is unknown or malformed.
	 * @throws {SmsErrors.OptedOut} If the endpoint is disabled.
	 * @throws {SmsErrors.SendFailed} General publish failure.
	 */
	async push(message: PushMessage): Promise<SendResult> {
		const target = message.target;
		// SNS accepts both topic ARNs and platform-endpoint ARNs via TargetArn.
		const command = new PublishCommand({
			TargetArn: target,
			...buildPushPayload(message),
		});

		try {
			const response = await this.client.send(command);
			return { messageId: response.MessageId ?? '' };
		} catch (err: any) {
			if (err.name && err.name in SmsErrors) throw err;
			throw mapSnsError(err);
		}
	}
}
