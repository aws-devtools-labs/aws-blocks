// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for Email. Imported by mock, aws, cdk, and browser entry points.
 * This file has zero runtime dependencies — types only.
 */
import type { ChildLogger } from '@aws-blocks/bb-logger';

/**
 * Configuration options for the Email building block instance.
 *
 * @param fromAddress - The verified sender email address (e.g., "noreply@example.com").
 * @param replyTo - Optional reply-to address(es).
 * @param configurationSet - Optional SES configuration set name for tracking.
 */
export interface EmailOptions {
	/** The verified sender email address. */
	fromAddress: string;
	/** Optional reply-to address(es). */
	replyTo?: string[];
	/** Optional SES configuration set name for tracking/events. */
	configurationSet?: string;
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;
}

/**
 * A complete email message used for both `send()` and `sendBatch()`.
 *
 * @param to - Recipient email address(es).
 * @param subject - The email subject line.
 * @param body - Plain text body content.
 * @param html - Optional HTML body content.
 * @param cc - Optional CC recipient address(es).
 * @param bcc - Optional BCC recipient address(es).
 */
export interface EmailMessage {
	/** Recipient email address(es). */
	to: string | string[];
	/** The email subject line. */
	subject: string;
	/** Plain text body content. */
	body: string;
	/** Optional HTML body content. */
	html?: string;
	/** Optional CC recipient address(es). */
	cc?: string[];
	/** Optional BCC recipient address(es). */
	bcc?: string[];
}

/**
 * Result of a `send()` operation.
 *
 * @param messageId - The SES message ID for the sent email.
 */
export interface SendResult {
	/** The SES message ID for the sent email. */
	messageId: string;
}

/**
 * Result of a `sendBatch()` operation with per-entry status.
 *
 * The `results` array is in the same order as the input `messages` array,
 * so callers can correlate each result to its corresponding input message by index.
 *
 * @param results - Array of per-message results matching input order.
 */
export interface SendBatchResult {
	/** Per-message results in the same order as the input messages array. */
	results: Array<{
		/** Whether this message was sent successfully or failed permanently. */
		status: 'success' | 'failed';
		/** The SES message ID, present when status is 'success'. */
		messageId?: string;
		/**
		 * Error description, present when status is 'failed'. A stable message naming the
		 * `EmailErrors` code or SES entry status — never the raw SES error text, which is
		 * logged server-side.
		 */
		error?: string;
	}>;
}
