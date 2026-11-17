// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { LogEntry } from '../contract/v1.js';
import { awsClientConfig } from './aws-config.js';

/**
 * Live Tail (M2): streams log events via CloudWatch Logs StartLiveTail.
 *
 * Live Tail is billed PER SESSION-MINUTE (~$0.01/min ≈ $0.60/hour) and the
 * account has a hard concurrent-session quota — an unbounded "tail
 * everything" would hit both. Hence the design-doc caps enforced here:
 * one session spans at most 10 log groups (the API maximum), the dashboard
 * allows 2 concurrent sessions, and every session auto-stops after 15
 * minutes. The route additionally stops on client disconnect.
 */

export const MAX_TAIL_GROUPS = 10;
export const MAX_TAIL_SESSIONS = 2;
export const MAX_TAIL_DURATION_MS = 15 * 60_000;

/** Live Tail wants log group ARNs (identifiers), not names. */
export function buildLogGroupArns(names: string[], region: string, accountId: string): string[] {
	return names.slice(0, MAX_TAIL_GROUPS).map((name) => `arn:aws:logs:${region}:${accountId}:log-group:${name}`);
}

/**
 * CloudWatch filter pattern for the session. bb-logger emits JSON, so a
 * level facet compiles to a JSON property selector; free text becomes a
 * quoted term. Both together AND (filter pattern semantics).
 */
export function buildTailFilterPattern(options: { level?: string; text?: string }): string | undefined {
	const parts: string[] = [];
	if (options.level) parts.push(`{ $.level = "${options.level.toLowerCase().replace(/"/g, '')}" }`);
	if (options.text) parts.push(`"${options.text.replace(/"/g, '')}"`);
	return parts.length > 0 ? parts.join(' ') : undefined;
}

/** Raw log event shape inside a StartLiveTail sessionUpdate. */
export interface RawTailEvent {
	timestamp?: number;
	message?: string;
	logGroupIdentifier?: string;
	logStreamName?: string;
}

/** Maps a Live Tail event to a LogEntry, parsing bb-logger JSON when present. */
export function tailEventToLogEntry(event: RawTailEvent): LogEntry {
	const message = event.message ?? '';
	const entry: LogEntry = {
		timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : '',
		message: message.trimEnd(),
		// Identifier is the group ARN; the name is everything after 'log-group:'.
		logGroup: event.logGroupIdentifier?.split('log-group:').pop() ?? '(unknown)',
		...(event.logStreamName ? { logStream: event.logStreamName } : {}),
	};
	try {
		const parsed = JSON.parse(message);
		if (parsed && typeof parsed === 'object') {
			if (typeof parsed.level === 'string') entry.level = parsed.level;
			if (typeof parsed.logger === 'string') entry.logger = parsed.logger;
			if (typeof parsed.traceId === 'string') entry.traceId = parsed.traceId;
			if (typeof parsed.message === 'string') entry.message = parsed.message;
		}
	} catch {
		// Non-JSON line — raw message stays.
	}
	return entry;
}

/**
 * Concurrent-session registry (module state: the dashboard is one Node
 * process). acquire returns a release function, or undefined when the cap
 * is reached — callers MUST call release exactly once when done.
 */
const activeSessions = new Set<symbol>();

export function acquireTailSlot(): (() => void) | undefined {
	if (activeSessions.size >= MAX_TAIL_SESSIONS) return undefined;
	const token = Symbol('tail-session');
	activeSessions.add(token);
	let released = false;
	return () => {
		if (!released) {
			released = true;
			activeSessions.delete(token);
		}
	};
}

/** Visible for tests and the route's error message. */
export function activeTailSessionCount(): number {
	return activeSessions.size;
}

/** Resolves the account id (needed for group ARNs) via STS. */
export async function fetchAccountId(region?: string): Promise<string> {
	const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
	const client = new STSClient(awsClientConfig(region));
	const identity = await client.send(new GetCallerIdentityCommand({}));
	if (!identity.Account) throw new Error('GetCallerIdentity returned no account id');
	return identity.Account;
}

export interface LiveTailHandle {
	/** Yields mapped log entries until the stream ends or close() is called. */
	events: AsyncGenerator<LogEntry, void, void>;
	close(): void;
}

/** Opens a StartLiveTail stream and yields mapped entries. */
export async function startLiveTailStream(options: {
	logGroupArns: string[];
	filterPattern?: string;
	region?: string;
}): Promise<LiveTailHandle> {
	const { CloudWatchLogsClient, StartLiveTailCommand } = await import('@aws-sdk/client-cloudwatch-logs');
	const client = new CloudWatchLogsClient(awsClientConfig(options.region));
	const abort = new AbortController();

	const response = await client.send(
		new StartLiveTailCommand({
			logGroupIdentifiers: options.logGroupArns,
			...(options.filterPattern ? { logEventFilterPattern: options.filterPattern } : {}),
		}),
		{ abortSignal: abort.signal },
	);

	async function* generate(): AsyncGenerator<LogEntry, void, void> {
		try {
			for await (const frame of response.responseStream ?? []) {
				if ('sessionUpdate' in frame && frame.sessionUpdate?.sessionResults) {
					for (const event of frame.sessionUpdate.sessionResults) {
						yield tailEventToLogEntry(event);
					}
				}
				// sessionStart frames carry metadata we already know; skip.
			}
		} catch (error) {
			// Abort-driven teardown is the expected close path, not a failure.
			if (!abort.signal.aborted) throw error;
		} finally {
			client.destroy();
		}
	}

	return {
		events: generate(),
		close: () => {
			abort.abort();
			client.destroy();
		},
	};
}
