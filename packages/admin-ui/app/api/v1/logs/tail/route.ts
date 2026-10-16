// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { API_VERSION, type ApiError, type TailMessage } from '@/contract/v1';
import { isAuthorized } from '@/server/auth';
import { classifyEventsError } from '@/server/cfn-events';
import {
	MAX_TAIL_DURATION_MS,
	MAX_TAIL_GROUPS,
	MAX_TAIL_SESSIONS,
	acquireTailSlot,
	buildLogGroupArns,
	buildTailFilterPattern,
	fetchAccountId,
	startLiveTailStream,
} from '@/server/live-tail';
import { getDataProvider } from '@/server/provider-registry';

/**
 * ndjson stream of TailMessage lines. Teardown paths, all of which release
 * the session slot and close the AWS stream (Live Tail bills per minute):
 * client disconnect (request abort), 15-minute max duration, AWS stream end.
 */
export async function GET(request: NextRequest): Promise<Response> {
	if (!isAuthorized(request.headers.get('authorization'))) {
		return NextResponse.json<ApiError>(
			{ apiVersion: API_VERSION, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid session token' } },
			{ status: 401 },
		);
	}

	const q = request.nextUrl.searchParams;
	const stage = q.get('stage') ?? 'sandbox';
	const level = q.get('level') ?? undefined;
	const text = q.get('text') ?? undefined;

	const encoder = new TextEncoder();
	const line = (msg: TailMessage) => encoder.encode(`${JSON.stringify(msg)}\n`);
	const ndjson = (body: ReadableStream<Uint8Array>, status = 200) =>
		new Response(body, {
			status,
			headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' },
		});
	const singleMessage = (msg: TailMessage, status: number) =>
		ndjson(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(line(msg));
					controller.close();
				},
			}),
			status,
		);

	// Session cap BEFORE any AWS call.
	const releaseSlot = acquireTailSlot();
	if (!releaseSlot) {
		return singleMessage(
			{
				type: 'error',
				code: 'SESSION_LIMIT',
				message: `Live Tail session limit reached (${MAX_TAIL_SESSIONS} concurrent). Stop another tail first.`,
			},
			429,
		);
	}

	try {
		const discovery = await getDataProvider().listLogGroups(stage);
		if (discovery.groupsSource === 'unavailable' || discovery.groups.length === 0) {
			releaseSlot();
			const code =
				discovery.groupsErrorCode === 'CREDENTIALS_EXPIRED' || discovery.groupsErrorCode === 'CREDENTIALS_MISSING'
					? discovery.groupsErrorCode
					: 'UNKNOWN';
			return singleMessage(
				{ type: 'error', code, message: discovery.groupsError ?? `No log groups found for stage "${stage}".` },
				discovery.groupsSource === 'unavailable' ? 502 : 404,
			);
		}

		const region = discovery.awsContext?.region;
		const accountId = await fetchAccountId(region);
		// Only groups that exist can be tailed; prefer confirmed ones (see search).
		const confirmed = discovery.groups.filter((g) => g.retentionDays !== undefined || g.storedBytes !== undefined);
		const groupNames = (confirmed.length > 0 ? confirmed : discovery.groups).slice(0, MAX_TAIL_GROUPS).map((g) => g.name);
		if (!region) throw new Error('Could not resolve a region for Live Tail (deploy first, or set AWS_REGION)');

		const tail = await startLiveTailStream({
			logGroupArns: buildLogGroupArns(groupNames, region, accountId),
			filterPattern: buildTailFilterPattern({ level, text }),
			region,
		});

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				let done = false;
				const finish = (reason: 'max-duration' | 'client-disconnect' | 'stream-closed') => {
					if (done) return;
					done = true;
					clearTimeout(maxTimer);
					try {
						controller.enqueue(line({ type: 'end', reason }));
						controller.close();
					} catch {
						// Controller already closed by cancel() — fine.
					}
					tail.close();
					releaseSlot();
				};

				const maxTimer = setTimeout(() => finish('max-duration'), MAX_TAIL_DURATION_MS);
				request.signal.addEventListener('abort', () => finish('client-disconnect'));

				controller.enqueue(
					line({
						type: 'session',
						groups: groupNames,
						startedAt: new Date().toISOString(),
						maxDurationMs: MAX_TAIL_DURATION_MS,
					}),
				);

				(async () => {
					try {
						for await (const entry of tail.events) {
							if (done) break;
							controller.enqueue(line({ type: 'event', entry }));
						}
						finish('stream-closed');
					} catch (error) {
						if (!done) {
							done = true;
							clearTimeout(maxTimer);
							try {
								controller.enqueue(
									line({
										type: 'error',
										code: classifyEventsError(error) === 'CREDENTIALS_EXPIRED' ? 'CREDENTIALS_EXPIRED' : 'UNKNOWN',
										message: error instanceof Error ? error.message : String(error),
									}),
								);
								controller.close();
							} catch {
								// Already closed.
							}
							tail.close();
							releaseSlot();
						}
					}
				})();
			},
			cancel() {
				// Reader went away without abort event (belt and braces).
				tail.close();
				releaseSlot();
			},
		});

		return ndjson(stream);
	} catch (error) {
		releaseSlot();
		const classified = classifyEventsError(error);
		return singleMessage(
			{
				type: 'error',
				code: classified === 'CREDENTIALS_EXPIRED' || classified === 'CREDENTIALS_MISSING' ? classified : 'UNKNOWN',
				message: `Could not start Live Tail: ${error instanceof Error ? error.message : String(error)}`,
			},
			502,
		);
	}
}
