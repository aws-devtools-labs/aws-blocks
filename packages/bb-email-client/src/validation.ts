// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Input validation shared by the mock and AWS entry points, so a message that
 * fails locally also fails when deployed (and the other way round). Internal to
 * the package — not re-exported from the entry points.
 */
import { blocksError } from '@aws-blocks/core';
import { EmailErrors } from './errors.js';
import type { EmailMessage } from './types.js';

/** SES limit: To + CC + BCC combined, per message. */
export const MAX_RECIPIENTS_PER_MESSAGE = 50;
/** SES limit on the total message size. */
export const MAX_MESSAGE_BYTES = 40 * 1024 * 1024; // 40 MB

// Basic RFC 5322 addr-spec
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
// RFC 5322 name-addr: `Display Name <addr-spec>`, which SES also accepts. The
// display name may not contain angle brackets.
const NAME_ADDR_REGEX = /^[^<>]*<([^<>]+)>$/;
// Control characters (CR/LF included) are never valid in an address.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Validate one address: a bare addr-spec (`user@example.com`) or a name-addr
 * (`Jane Doe <user@example.com>`).
 *
 * @throws {EmailErrors.InvalidInput} If the address is malformed.
 */
export function validateEmailAddress(address: string): void {
	const candidate = typeof address === 'string' ? address.trim() : '';
	const addrSpec = NAME_ADDR_REGEX.exec(candidate)?.[1] ?? candidate;
	if (CONTROL_CHARS.test(String(address)) || !EMAIL_REGEX.test(addrSpec)) {
		throw blocksError(EmailErrors.InvalidInput, `Invalid email address: ${address}`);
	}
}

/** Validate one address or a list of them. */
export function validateAddresses(addresses: string | string[]): void {
	const list = Array.isArray(addresses) ? addresses : [addresses];
	for (const addr of list) {
		validateEmailAddress(addr);
	}
}

/** Number of recipients on a message: To + CC + BCC combined. */
export function countRecipients(msg: { to: string | string[]; cc?: string[]; bcc?: string[] }): number {
	const toCount = Array.isArray(msg.to) ? msg.to.length : 1;
	const ccCount = msg.cc?.length ?? 0;
	const bccCount = msg.bcc?.length ?? 0;
	return toCount + ccCount + bccCount;
}

/**
 * Validate a message before it is sent: every address (sender included), the
 * recipient count and the total size. Both `send()` and each `sendBatch()`
 * entry go through this, on the mock and on AWS.
 *
 * @throws {EmailErrors.InvalidInput} If any address is malformed or the message has more than 50 recipients.
 * @throws {EmailErrors.SendFailed} If the message exceeds 40 MB.
 */
export function validateMessage(message: EmailMessage, fromAddress: string): void {
	const { to, cc, bcc } = message;
	validateAddresses(to);
	validateEmailAddress(fromAddress);
	if (cc) validateAddresses(cc);
	if (bcc) validateAddresses(bcc);

	if (countRecipients({ to, cc, bcc }) > MAX_RECIPIENTS_PER_MESSAGE) {
		throw blocksError(EmailErrors.InvalidInput, `Recipient count exceeds ${MAX_RECIPIENTS_PER_MESSAGE}.`);
	}

	const messageSize = Buffer.byteLength(JSON.stringify(message), 'utf8');
	if (messageSize > MAX_MESSAGE_BYTES) {
		throw blocksError(EmailErrors.SendFailed, `Message size ${messageSize} bytes exceeds the 40 MB limit`);
	}
}
