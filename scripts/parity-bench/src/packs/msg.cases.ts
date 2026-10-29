// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Messaging (bb-realtime + bb-email-client) parity cases. Pure data — executed by msg.probe.ts.

import type { ParityCase } from '../core/types.js';

const WS_QUOTAS = 'https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html';
const DDB_KEY_LIMITS =
	'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html#limits-partition-sort-keys';
const RT_DESIGN = 'packages/bb-realtime/DESIGN.md "Channel Name Limits" + "Server-Side Subscribe"';
const SES_SIMULATOR = 'https://docs.aws.amazon.com/ses/latest/dg/send-an-email-from-console.html';
const SES_SANDBOX = 'https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html';
const SES_QUOTAS = 'https://docs.aws.amazon.com/ses/latest/dg/quotas.html';
const SES_MESSAGE = 'https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_Message.html';
const SES_CONTENT = 'https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_Content.html';

/**
 * Realtime publish sizes, measured as the block's own wire envelope
 * `JSON.stringify({ type: 'message', channel, data })` in UTF-8 bytes (what
 * `validatePublishSize` checks and what `postToConnection` sends).
 */
const RT_ENVELOPE_SIZES: readonly { bytes: number; why: string }[] = [
	{ bytes: 1024, why: 'small baseline' },
	{ bytes: 32_768, why: 'exactly one 32 KB WebSocket frame' },
	{ bytes: 32_769, why: 'one byte over the 32 KB frame quota (must be split into frames)' },
	{ bytes: 131_072, why: 'exactly the 128 KB message payload quota (block accepts it)' },
	{ bytes: 131_073, why: 'one byte over the 128 KB message payload quota (block rejects it)' },
];

const realtimeCases: readonly ParityCase[] = [
	{
		id: 'msg.rt-publish.publish.no-subscriber',
		pack: 'msg',
		block: 'bb-realtime',
		category: 'consistency',
		description: 'publish() a 1,024-byte envelope to a fresh channel nobody subscribes to',
		source: `${RT_DESIGN} ("Publish Fan-Out": GSI query, then postToConnection per subscriber)`,
		params: { kind: 'publish-only', envelopeBytes: 1024, channelBytes: 0 },
	},
	...RT_ENVELOPE_SIZES.map(
		({ bytes, why }): ParityCase => ({
			id: `msg.rt-size.server-subscribe.${bytes}`,
			pack: 'msg',
			block: 'bb-realtime',
			category: 'limits',
			description: `getChannel().subscribe() server-side, then publish() a ${bytes}-byte envelope (${why}); count deliveries`,
			source: `${WS_QUOTAS} (WebSocket frame size 32 KB; message payload size 128 KB, applies to @connections; larger closes with 1009)`,
			params: { kind: 'delivery', envelopeBytes: bytes, channelBytes: 0 },
		}),
	),
	{
		id: 'msg.rt-channel.server-subscribe.path-1024-bytes',
		pack: 'msg',
		block: 'bb-realtime',
		category: 'limits',
		description: 'subscribe + publish on a channel whose full path is exactly 1,024 UTF-8 bytes (the block maximum)',
		source: `${DDB_KEY_LIMITS} (sort key max 1,024 bytes; GSI partition key max 2,048 bytes); ${RT_DESIGN}`,
		params: { kind: 'delivery', envelopeBytes: 0, channelBytes: 1024 },
	},
];

const emailCases: readonly ParityCase[] = [
	{
		id: 'msg.email-recipient.send.simulator-scenarios',
		pack: 'msg',
		block: 'bb-email-client',
		category: 'errors',
		description: 'send() once each to the SES mailbox simulator success, bounce, complaint and suppressionlist addresses',
		source: `${SES_SIMULATOR} (simulator works in the sandbox; bounces/complaints are asynchronous)`,
		params: { kind: 'simulator' },
	},
	{
		id: 'msg.email-recipient.send.unverified-example-com',
		pack: 'msg',
		block: 'bb-email-client',
		category: 'errors',
		description: 'send() to an unverified recipient at the reserved example.com domain',
		source: `${SES_SANDBOX} (sandbox: send only to verified addresses or the mailbox simulator)`,
		params: { kind: 'unverified-send' },
	},
	{
		id: 'msg.email-recipient.sendBatch.unverified-example-com',
		pack: 'msg',
		block: 'bb-email-client',
		category: 'errors',
		description: 'sendBatch() of [simulator success, unverified example.com recipient]; per-entry statuses',
		source: `${SES_SANDBOX} (sandbox: send only to verified addresses or the mailbox simulator)`,
		params: { kind: 'unverified-batch' },
	},
	{
		id: 'msg.email-content.send.empty-subject',
		pack: 'msg',
		block: 'bb-email-client',
		category: 'errors',
		description: "send() to the simulator with subject '' (body non-empty)",
		source: `${SES_MESSAGE} (Subject required); ${SES_CONTENT} (Data required)`,
		params: { kind: 'content', variant: 'empty-subject' },
	},
	{
		id: 'msg.email-content.send.non-ascii-no-charset',
		pack: 'msg',
		block: 'bb-email-client',
		category: 'errors',
		description: 'send() to the simulator with a non-ASCII subject and body; the block sets no Charset',
		source: `${SES_MESSAGE} (subject is 7-bit ASCII unless RFC 2047 encoded); ${SES_CONTENT} (non-ASCII text needs a Charset)`,
		params: { kind: 'content', variant: 'non-ascii' },
	},
	{
		id: 'msg.email-address.send.local-part-80-chars',
		pack: 'msg',
		block: 'bb-email-client',
		category: 'errors',
		description: 'send() to a simulator address whose local part is 80 characters (the block regex has no 64-octet cap)',
		source: 'https://www.rfc-editor.org/rfc/rfc5321#section-4.5.3.1.1 (local part max 64 octets); packages/bb-email-client/DESIGN.md "Input Validation"',
		params: { kind: 'address', variant: 'long-local' },
	},
	{
		id: 'msg.email-address.send.consecutive-dots',
		pack: 'msg',
		block: 'bb-email-client',
		category: 'errors',
		description: "send() to 'success+a..b@simulator.amazonses.com' (dot-atom forbids '..'; the block regex allows it)",
		source: 'https://www.rfc-editor.org/rfc/rfc5322#section-3.4.1 (dot-atom local part); packages/bb-email-client/DESIGN.md "Input Validation"',
		params: { kind: 'address', variant: 'double-dot' },
	},
	{
		id: 'msg.email-recipients.send.50',
		pack: 'msg',
		block: 'bb-email-client',
		category: 'limits',
		description: 'send() one message to 50 labeled simulator recipients (To + CC + BCC = 50, the SES maximum)',
		source: `${SES_QUOTAS} (50 recipients per message, To + CC + BCC; sandbox rate 1 email/s; quotas count recipients)`,
		params: { kind: 'recipients', recipients: 50 },
	},
];

/** The 50-recipient send is the last case: it can drain the sandbox's 1 email/s rate for whatever runs after it. */
export const msgCases: readonly ParityCase[] = [...realtimeCases, ...emailCases];
