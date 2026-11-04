// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

/** SQS queue names allow only these characters, up to 80 of them. */
const SQS_NAME_CHARS = /^[A-Za-z0-9_-]+$/;
const MAX_QUEUE_NAME = 80;
const DLQ_SUFFIX = '-dlq';

/**
 * Derive a job's queue and dead-letter queue names from its `fullId`.
 *
 * A `fullId` made only of characters SQS allows keeps the names every deployed
 * job already has: the `fullId` capped at 80 characters, and the DLQ name with
 * room reserved for `-dlq` (so the two never truncate to the same name).
 *
 * Any other `fullId` (for example one with a `.`, which bucket-style ids can
 * contain) could never deploy, so it is free to take a new form: each run of
 * disallowed characters becomes `-`, and an 8-character hash of the whole
 * `fullId` keeps ids that sanitize alike (`a.b`, `a-b`) distinct.
 *
 * Only the CDK layer calls this. The runtime reads the provisioned queue URL
 * from config, so it never re-derives the name.
 */
export function deriveQueueNames(fullId: string): { queueName: string; dlqName: string } {
	if (SQS_NAME_CHARS.test(fullId)) {
		return {
			queueName: fullId.substring(0, MAX_QUEUE_NAME),
			dlqName: `${fullId.substring(0, MAX_QUEUE_NAME - DLQ_SUFFIX.length)}${DLQ_SUFFIX}`,
		};
	}
	const hash = createHash('sha256').update(fullId).digest('hex').slice(0, 8);
	const base = fullId.replace(/[^A-Za-z0-9_-]+/g, '-');
	const withHash = (max: number) => `${base.substring(0, max - hash.length - 1)}-${hash}`;
	return {
		queueName: withHash(MAX_QUEUE_NAME),
		dlqName: `${withHash(MAX_QUEUE_NAME - DLQ_SUFFIX.length)}${DLQ_SUFFIX}`,
	};
}
