// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// AsyncJob (bb-async-job) and CronJob (bb-cron-job) parity cases. Pure data — executed by job.probe.ts.

import type { ParityCase } from '../core/types.js';

const SEND_MESSAGE = 'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SendMessage.html';
const SEND_MESSAGE_BATCH = 'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SendMessageBatch.html';
const STANDARD_QUEUES = 'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues.html';
const LAMBDA_SQS = 'https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html';
const SCHEDULER_CONTEXT = 'https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-schedule-context-attributes.html';
const ASYNC_JOB_DESIGN = 'packages/bb-async-job/DESIGN.md';

/** How long a case waits for the handler. Keeps every case well under API Gateway's 29 s limit. */
const WAIT_MS = 12_000;

function asyncJobCase(
	id: string,
	category: ParityCase['category'],
	description: string,
	source: string,
	params: ParityCase['params'],
): ParityCase {
	return { id: `job.${id}`, pack: 'job', block: 'bb-async-job', category, description, source, params };
}

export const jobCases: readonly ParityCase[] = [
	asyncJobCase(
		'roundtrip.submit.basic',
		'async',
		'submit() one payload, wait for the handler; record jobId shape, handler context, and status transitions',
		`${ASYNC_JOB_DESIGN} (D-AJ-7; context = { jobId: MessageId, receiveCount, sentAt })`,
		{ kind: 'basic', waitMs: WAIT_MS },
	),
	// The block sends JSON.stringify(payload) as the MessageBody, and SQS measures the body in UTF-8 bytes.
	// The block caps it at 256 KiB, which is now stricter than SQS's own 1 MiB limit.
	...[262_143, 262_144, 262_145].map((bodyBytes) =>
		asyncJobCase(
			`payload-size.submit.${bodyBytes}`,
			'limits',
			`submit() a payload whose serialized MessageBody is exactly ${bodyBytes} UTF-8 bytes`,
			`${SEND_MESSAGE} (MessageBody max 1 MiB) + ${ASYNC_JOB_DESIGN} (D-AJ-4: 256 KB client-side cap)`,
			{ kind: 'size', bodyBytes, waitMs: WAIT_MS },
		),
	),
	asyncJobCase(
		'payload-chars.submit.u-ffff',
		'errors',
		'submit() a string containing U+FFFF, which JSON.stringify leaves unescaped and SQS does not allow',
		`${SEND_MESSAGE} (allowed: #x9 | #xA | #xD | #x20-#xD7FF | #xE000-#xFFFD | #x10000-#x10FFFF, else InvalidMessageContents)`,
		{ kind: 'chars', codePoint: 0xffff, waitMs: WAIT_MS },
	),
	asyncJobCase(
		'serialization.submit.rich-types',
		'consistency',
		'submit() a payload holding Date, undefined, NaN, Infinity, Map, Set and an array hole; record the types the handler sees',
		`${SEND_MESSAGE} (MessageBody is a string; the block serializes with JSON.stringify)`,
		{ kind: 'types', waitMs: WAIT_MS },
	),
	asyncJobCase(
		'payload-isolation.submit.mutate-after-submit',
		'consistency',
		'mutate the payload object right after submit() resolves; record which value the handler sees',
		`${SEND_MESSAGE} (the body is captured at SendMessage time)`,
		{ kind: 'mutate', waitMs: WAIT_MS },
	),
	asyncJobCase(
		'delay.submit.2',
		'async',
		'submit() with delaySeconds 2; record whether the handler ran, and not before the delay',
		`${SEND_MESSAGE} (DelaySeconds: valid values 0 to 900)`,
		{ kind: 'delay', delaySeconds: 2, waitMs: WAIT_MS },
	),
	...[900, 901, -1].map((delaySeconds) =>
		asyncJobCase(
			`delay.submit.${delaySeconds < 0 ? 'negative' : delaySeconds}`,
			'limits',
			`submit() with delaySeconds ${delaySeconds} (the block does not range-check it)`,
			`${SEND_MESSAGE} (DelaySeconds: valid values 0 to 900, type Integer)`,
			{ kind: 'delay', delaySeconds, waitMs: delaySeconds < 0 ? WAIT_MS : 0 },
		),
	),
	asyncJobCase(
		'retry.handler.fail-once',
		'async',
		`handler throws on its first delivery; record the receiveCounts and status transitions seen within ${WAIT_MS / 1000} s`,
		`${LAMBDA_SQS} (failed messages become visible again after the visibility timeout) + ${ASYNC_JOB_DESIGN} (D-AJ-1a: 900 s + window)`,
		{ kind: 'retry', failTimes: 1, waitMs: WAIT_MS },
	),
	asyncJobCase(
		'retry.handler.fail-always',
		'async',
		`handler always throws (maxRetries 3); record the receiveCounts and status seen within ${WAIT_MS / 1000} s`,
		`${LAMBDA_SQS} (redrive to the DLQ after maxReceiveCount) + ${ASYNC_JOB_DESIGN} (D-AJ-1)`,
		{ kind: 'retry', failTimes: 99, waitMs: WAIT_MS },
	),
	asyncJobCase(
		'ordering.submit.sequential-5',
		'consistency',
		'submit() 5 jobs one after another; record the order the handler started them in',
		`${STANDARD_QUEUES} (best-effort ordering, at-least-once delivery)`,
		{ kind: 'order', count: 5, waitMs: WAIT_MS },
	),
	asyncJobCase(
		'batch.submitBatch.12x30kb',
		'limits',
		'submitBatch() 12 payloads of ~30 KB (over 10 entries and over 256 KB aggregate); record ids, failures and handler runs',
		`${SEND_MESSAGE_BATCH} (10 entries, 1 MiB total) + ${ASYNC_JOB_DESIGN} (D-AJ-4a: chunks at 10 entries / 256 KB)`,
		{ kind: 'batch', count: 12, padBytes: 30_000, waitMs: WAIT_MS },
	),
	{
		id: 'job.cron.event.rate-1m-shape',
		pack: 'job',
		block: 'bb-cron-job',
		category: 'consistency',
		description: 'read the last event a rate(1 minute) CronJob handler recorded; report scheduledTime format, jobName and input types',
		source: `${SCHEDULER_CONTEXT} (<aws.scheduler.scheduled-time>, e.g. 2022-03-22T18:59:43Z)`,
		params: { kind: 'cron' },
	},
];
