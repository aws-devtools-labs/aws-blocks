// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for SmsClient. Imported by mock, aws, cdk, and browser entry points.
 * This file has zero runtime dependencies — types only.
 */
import type { ChildLogger } from '@aws-blocks/bb-logger';

/**
 * SMS delivery class.
 *
 * - `Transactional` — prioritizes delivery reliability (one-time passwords,
 *   alerts). Higher cost, no opt-out keyword handling.
 * - `Promotional` — optimizes cost for non-critical messages (marketing).
 *   May be dropped by carriers more aggressively.
 */
export type SmsType = 'Transactional' | 'Promotional';

/**
 * Configuration options for the SmsClient building block instance.
 *
 * @param senderId - Default alphanumeric sender ID shown to recipients, where
 *   supported by the destination country. Ignored in countries that don't
 *   support sender IDs (e.g. the US).
 * @param smsType - Default delivery class applied to every `send()` unless the
 *   message overrides it. Defaults to `Transactional`.
 * @param logger - Optional logger for internal operations. When omitted, a
 *   default Logger at error level is created.
 */
export interface SmsOptions {
	/** Default alphanumeric sender ID, where supported by the destination country. */
	senderId?: string;
	/** Default delivery class. Defaults to `Transactional`. */
	smsType?: SmsType;
	/** Optional logger for internal operations. */
	logger?: ChildLogger;
}

/**
 * A single SMS message for `send()` and `sendBatch()`.
 *
 * @param to - Destination phone number in E.164 format (e.g. `+14155550123`).
 * @param body - The text body. Long messages are split into multiple SMS parts
 *   by the carrier; total size must not exceed 1600 bytes (UTF-8).
 * @param senderId - Optional per-message sender ID override.
 * @param smsType - Optional per-message delivery class override.
 */
export interface SmsMessage {
	/** Destination phone number in E.164 format (e.g. `+14155550123`). */
	to: string;
	/** The text body. */
	body: string;
	/** Optional per-message sender ID override. */
	senderId?: string;
	/** Optional per-message delivery class override. */
	smsType?: SmsType;
}

/**
 * A mobile push notification delivered through an Amazon SNS platform endpoint
 * or topic.
 *
 * @param target - The SNS endpoint ARN (a registered device) or topic ARN to
 *   publish to.
 * @param body - The notification body text. Used as the `default` message and
 *   the alert body on APNS/FCM.
 * @param title - Optional notification title (APNS/FCM).
 * @param data - Optional structured data payload delivered alongside the
 *   notification.
 * @param badge - Optional iOS badge count.
 */
export interface PushMessage {
	/** The SNS endpoint ARN or topic ARN to publish to. */
	target: string;
	/** The notification body text. */
	body: string;
	/** Optional notification title. */
	title?: string;
	/** Optional structured data payload. */
	data?: Record<string, unknown>;
	/** Optional iOS badge count. */
	badge?: number;
}

/**
 * Result of a `send()` or `push()` operation.
 *
 * @param messageId - The SNS message ID for the published message.
 */
export interface SendResult {
	/** The SNS message ID for the published message. */
	messageId: string;
}

/**
 * Result of a `sendBatch()` operation with per-entry status.
 *
 * The `results` array is in the same order as the input `messages` array, so
 * callers can correlate each result to its input message by index.
 *
 * @param results - Array of per-message results matching input order.
 */
export interface SendBatchResult {
	/** Per-message results in the same order as the input messages array. */
	results: Array<{
		/** Whether this message was sent successfully or failed permanently. */
		status: 'success' | 'failed';
		/** The SNS message ID, present when status is 'success'. */
		messageId?: string;
		/** Error description, present when status is 'failed'. */
		error?: string;
	}>;
}
