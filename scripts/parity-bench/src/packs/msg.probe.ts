// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Messaging (bb-realtime + bb-email-client) parity runner for msg.cases.ts.

import { randomUUID } from 'node:crypto';
import { EmailClient } from '@aws-blocks/blocks';
import type { EmailMessage, Scope } from '@aws-blocks/blocks';
import type { DisconnectReason, NamespaceConfig, RealtimeServer, RealtimeSubscription } from '@aws-blocks/bb-realtime';
import { param, pollFor, runCase } from '../server/helpers.js';
import type { ParityCase, ProbeRun, ProbeRunner } from '../core/types.js';

/** The app's cursor schema (`index.ts`): the padding goes in `color`. */
export interface ProbeCursor {
	userId: string;
	x: number;
	y: number;
	color: string;
}

/** The app's existing `realtime` instance; reused because every `Realtime` shares one per-stack WebSocket API. */
export type ProbeRealtime = RealtimeServer<{ cursors: NamespaceConfig<ProbeCursor> }>;

export interface MsgProbeDeps {
	readonly realtime: ProbeRealtime;
}

// Deployed budget per case (API Gateway's 29 s integration timeout): connect +
// subscribe, then wait for the subscription to reach the channel GSI, then delivery.
const ESTABLISH_TIMEOUT_MS = 6000;
const WARMUP_TIMEOUT_MS = 4000;
// How long one warm-up publish waits for its delivery before the next is sent.
const WARMUP_WAIT_MS = 1000;
const DELIVERY_TIMEOUT_MS = 3000;
// After the first delivery, how long to keep counting (a duplicate arrives later than the original).
const DUPLICATE_GRACE_MS = 500;
// The SES sandbox sends at most 1 message per second; pace sends so the rate never decides an outcome.
const SES_PACE_MS = 1100;

const SIMULATOR = 'simulator.amazonses.com';
// RFC 2606 reserved domain: never delivered, and unverified in any SES account.
const UNVERIFIED_RECIPIENT = 'pty-probe@example.com';
// The unverified-recipient cases only make sense — and are only harmless — while
// the account's SES is in sandbox mode, where SES rejects the send. With production
// access the mail would really go out and hard-bounce against the sender's
// reputation, so they run only when the operator confirms sandbox mode.
const SES_SANDBOX_CONFIRMED = process.env.E2E_PARITY_SES_SANDBOX === 'true';
const SES_SANDBOX_SKIP = 'E2E_PARITY_SES_SANDBOX not set (set it only for an account in SES sandbox mode)';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function channelId(): string {
	return `pty-${randomUUID().slice(0, 8)}`;
}

function errorName(e: unknown): string {
	return e instanceof Error ? e.name : typeof e;
}

/** The block's own wire envelope — what `validatePublishSize` measures and `postToConnection` sends. */
function envelopeBytes(fullChannel: string, data: ProbeCursor): number {
	return Buffer.byteLength(JSON.stringify({ type: 'message', channel: fullChannel, data }), 'utf8');
}

/** A cursor whose envelope on `fullChannel` is exactly `bytes` UTF-8 bytes. */
function cursorOfEnvelope(fullChannel: string, bytes: number): ProbeCursor {
	const base: ProbeCursor = { userId: 'pty', x: 0, y: 0, color: '' };
	const pad = bytes - envelopeBytes(fullChannel, base);
	if (pad < 0) throw new Error(`envelope of ${bytes} bytes is smaller than the empty cursor`);
	return { ...base, color: 'a'.repeat(pad) };
}

/** Fully-qualified channel path, read from the public channel descriptor. */
async function fullChannelOf(rt: ProbeRealtime, channel: string): Promise<string> {
	return (await rt.getChannel('cursors', channel)).toJSON().channel;
}

/** Resolve to 'ok', 'timeout' or the rejection's error name. */
async function settle(p: Promise<void>, timeoutMs: number): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<string>((r) => {
		timer = setTimeout(() => r('timeout'), timeoutMs);
	});
	try {
		return await Promise.race([p.then(() => 'ok', errorName), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

function isMessageFrame(data: unknown): boolean {
	if (typeof data !== 'string') return false;
	try {
		const parsed: unknown = JSON.parse(data);
		return typeof parsed === 'object' && parsed !== null && 'type' in parsed && parsed.type === 'message';
	} catch {
		return false;
	}
}

interface DeliveryState {
	sub: RealtimeSubscription;
	/** Times the subscriber's `onMessage` ran. */
	handlerCalls: () => number;
	/** Messages that crossed the transport: frames on the WebSocket deployed, handler calls locally (one in-process path). */
	delivered: () => number;
	disconnects: DisconnectReason[];
}

/** Server-side subscriber on `channel`, observed both at the handler and (deployed) on its WebSocket. */
async function subscribeObserved(rt: ProbeRealtime, channel: string): Promise<DeliveryState> {
	const ch = await rt.getChannel('cursors', channel);
	let calls = 0;
	let frames = 0;
	const disconnects: DisconnectReason[] = [];
	const sub = ch.subscribe({
		onMessage: () => {
			calls++;
		},
		onDisconnect: (reason) => {
			disconnects.push(reason);
		},
	});
	const ws = sub.connection;
	ws?.addEventListener('message', (ev) => {
		if (isMessageFrame(ev.data)) frames++;
	});
	return { sub, handlerCalls: () => calls, delivered: () => (ws ? frames : calls), disconnects };
}

/**
 * Subscribe, wait until a small message reaches the subscriber (the subscription
 * record is in the channel index), then publish `data` and count what arrives.
 */
async function deliveryAct(rt: ProbeRealtime, channel: string, s: DeliveryState, data: ProbeCursor) {
	const established = await settle(s.sub.established, ESTABLISH_TIMEOUT_MS);
	if (established !== 'ok') return { established };
	const warm: ProbeCursor = { userId: 'pty-warm', x: 0, y: 0, color: '' };
	const ready = await pollFor(
		async () => {
			await rt.publish('cursors', channel, warm);
			return pollFor(async () => (s.delivered() > 0 ? true : undefined), WARMUP_WAIT_MS, 50);
		},
		WARMUP_TIMEOUT_MS,
		0,
	);
	// Let a straggling warm-up message land before the baseline is taken.
	if (ready) await sleep(DUPLICATE_GRACE_MS);
	const baseDelivered = s.delivered();
	const baseCalls = s.handlerCalls();
	const baseDisconnects = s.disconnects.length;
	await rt.publish('cursors', channel, data);
	const arrived = await pollFor(async () => (s.delivered() > baseDelivered ? true : undefined), DELIVERY_TIMEOUT_MS, 50);
	if (arrived) await sleep(DUPLICATE_GRACE_MS);
	return {
		established,
		ready: ready === true,
		deliveries: s.delivered() - baseDelivered,
		handlerCalls: s.handlerCalls() - baseCalls,
		disconnects: s.disconnects.slice(baseDisconnects),
	};
}

function realtimeCase(rt: ProbeRealtime, c: ParityCase): Promise<ProbeRun> {
	const kind = param(c.params, 'kind', 'string');
	const envelope = param(c.params, 'envelopeBytes', 'number');
	const channelBytes = param(c.params, 'channelBytes', 'number');
	const id = channelId();

	if (kind === 'publish-only') {
		return runCase({
			setup: async () => {
				const full = await fullChannelOf(rt, id);
				return cursorOfEnvelope(full, envelope);
			},
			act: async (data) => {
				await rt.publish('cursors', id, data);
				return { published: true };
			},
		});
	}

	if (kind !== 'delivery') throw new Error(`unknown realtime probe kind ${kind}`);
	return runCase({
		setup: async () => {
			let channel = id;
			if (channelBytes > 0) {
				// Pad the channel (ASCII) so the full path `{fullId}/cursors/{channel}` is exactly `channelBytes` bytes.
				const prefixBytes = Buffer.byteLength(await fullChannelOf(rt, ''), 'utf8');
				channel = `${id}-`.padEnd(channelBytes - prefixBytes, 'c');
			}
			const full = await fullChannelOf(rt, channel);
			const data = envelope > 0 ? cursorOfEnvelope(full, envelope) : { userId: 'pty', x: 1, y: 1, color: 'red' };
			return { channel, data, observed: await subscribeObserved(rt, channel) };
		},
		act: async ({ channel, data, observed }) => deliveryAct(rt, channel, observed, data),
		cleanup: async (state) => {
			state?.observed.sub.unsubscribe();
		},
	});
}

function emailCase(email: EmailClient, c: ParityCase): Promise<ProbeRun> {
	const kind = param(c.params, 'kind', 'string');
	const simple = (to: string, overrides: Partial<EmailMessage> = {}): EmailMessage => ({
		to,
		subject: 'AWS Blocks parity probe',
		body: 'AWS Blocks parity probe. No action needed.',
		...overrides,
	});
	const sendOne = async (message: EmailMessage) => {
		await email.send(message);
		return { sent: true };
	};
	const paced = (act: () => Promise<unknown>) => runCase({ setup: () => sleep(SES_PACE_MS), act });

	switch (kind) {
		case 'simulator':
			return paced(async () => {
				const outcomes: Record<string, string> = {};
				for (const scenario of ['success', 'bounce', 'complaint', 'suppressionlist']) {
					try {
						await email.send(simple(`${scenario}+pty@${SIMULATOR}`));
						outcomes[scenario] = 'ok';
					} catch (e) {
						outcomes[scenario] = errorName(e);
					}
					await sleep(SES_PACE_MS);
				}
				return outcomes;
			});
		case 'unverified-send':
			if (!SES_SANDBOX_CONFIRMED) return runCase({ setup: async () => {}, act: async () => ({ skipped: SES_SANDBOX_SKIP }) });
			return paced(() => sendOne(simple(UNVERIFIED_RECIPIENT)));
		case 'unverified-batch':
			if (!SES_SANDBOX_CONFIRMED) return runCase({ setup: async () => {}, act: async () => ({ skipped: SES_SANDBOX_SKIP }) });
			return paced(async () => {
				const { results } = await email.sendBatch([simple(`success+pty@${SIMULATOR}`), simple(UNVERIFIED_RECIPIENT)]);
				return { statuses: results.map((r) => r.status) };
			});
		case 'recipients': {
			const n = param(c.params, 'recipients', 'number');
			const all = Array.from({ length: n }, (_, i) => `success+pty${i}@${SIMULATOR}`);
			return paced(() =>
				sendOne(simple(all[0], { to: all.slice(0, 20), cc: all.slice(20, 40), bcc: all.slice(40) })),
			);
		}
		case 'content': {
			const variant = param(c.params, 'variant', 'string');
			const to = `success+pty@${SIMULATOR}`;
			if (variant === 'empty-subject') return paced(() => sendOne(simple(to, { subject: '' })));
			if (variant === 'non-ascii') {
				return paced(() => sendOne(simple(to, { subject: 'Paritätsprüfung ✓', body: 'Grüße — 你好 ✓' })));
			}
			throw new Error(`unknown email content variant ${variant}`);
		}
		case 'address': {
			const variant = param(c.params, 'variant', 'string');
			// Both stay on the simulator domain, so a send that SES accepts is never delivered anywhere real.
			if (variant === 'long-local') return paced(() => sendOne(simple(`success+${'a'.repeat(72)}@${SIMULATOR}`)));
			if (variant === 'double-dot') return paced(() => sendOne(simple(`success+a..b@${SIMULATOR}`)));
			throw new Error(`unknown email address variant ${variant}`);
		}
		default:
			throw new Error(`unknown email probe kind ${kind}`);
	}
}

/**
 * Reuses the app's `realtime` instance and constructs one `EmailClient` with the
 * same verified sender as the app's (`E2E_FROM_EMAIL`), so probe sends stay out
 * of the app instance's mock `emails.json`. An EmailClient owns no AWS resources:
 * at synth it only adds an SES send grant to the shared execution role.
 */
export function msgProbe(scope: Scope, deps: MsgProbeDeps): ProbeRunner {
	const email = new EmailClient(scope, 'pty-mail', {
		fromAddress: process.env.E2E_FROM_EMAIL || 'noreply@example.com',
	});
	return (c) => {
		if (c.block === 'bb-realtime') return realtimeCase(deps.realtime, c);
		if (c.block === 'bb-email-client') return emailCase(email, c);
		throw new Error(`msg pack has no runner for block ${c.block}`);
	};
}
