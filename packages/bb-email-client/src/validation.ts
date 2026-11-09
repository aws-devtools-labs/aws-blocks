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
// display name is either a phrase of atoms separated by spaces (`Jane Doe`) or a
// single quoted-string (`"Doe, Jane"`), so a comma or semicolon outside quotes
// can't turn one entry into a list of addresses.
const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const PHRASE = `${ATOM}(?:[ \\t]+${ATOM})*`;
const QUOTED_STRING = '"(?:[^"\\\\]|\\\\.)*"';
const NAME_ADDR_REGEX = new RegExp(`^(?:(?:${PHRASE}|${QUOTED_STRING})[ \\t]*)?<([^<>]+)>$`);
// Control characters are never valid in an address: C0 (CR/LF included), DEL,
// C1 (NEL included), and the Unicode line and paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Quote an address for an error message, with control characters escaped, so none reach logs raw. */
function quoteForMessage(address: unknown): string {
	return JSON.stringify(String(address)).replace(
		CONTROL_CHARS_GLOBAL,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
	);
}

/**
 * Validate one address: a bare addr-spec (`user@example.com`) or a name-addr
 * (`Jane Doe <user@example.com>`, `"Doe, Jane" <user@example.com>`). The raw
 * string is validated as given (no trimming), since that is what SES receives.
 *
 * @throws {EmailErrors.InvalidInput} If the address is malformed.
 */
export function validateEmailAddress(address: string): void {
	const candidate = typeof address === 'string' ? address : '';
	const addrSpec = NAME_ADDR_REGEX.exec(candidate)?.[1] ?? candidate;
	if (CONTROL_CHARS.test(candidate) || !EMAIL_REGEX.test(addrSpec)) {
		throw blocksError(EmailErrors.InvalidInput, `Invalid email address: ${quoteForMessage(address)}`);
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
 * Validate a message before it is sent: every address (To, CC, BCC, the sender
 * and any reply-to), the recipient count and the total size. Both `send()` and
 * each `sendBatch()` entry go through this, on the mock and on AWS.
 *
 * The size check is an approximate early check: it measures the message as
 * JSON, without MIME headers or transfer-encoding overhead, so a message under
 * it can still exceed SES's 40 MB limit once encoded.
 *
 * @throws {EmailErrors.InvalidInput} If any address is malformed or the message has more than 50 recipients.
 * @throws {EmailErrors.SendFailed} If the message exceeds 40 MB.
 */
export function validateMessage(message: EmailMessage, fromAddress: string, replyTo?: string[]): void {
	const { to, cc, bcc } = message;
	validateAddresses(to);
	validateEmailAddress(fromAddress);
	if (replyTo) validateAddresses(replyTo);
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
