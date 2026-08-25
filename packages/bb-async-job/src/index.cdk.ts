// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { BuildingBlockScope } from '@aws-blocks/core/cdk';
import { registerConfig, synthGuard, SHARED_HANDLER_TIMEOUT_SECONDS } from '@aws-blocks/core/cdk';
import type { VpcRequirements } from '@aws-blocks/core/cdk';
import { DistributedTable } from '@aws-blocks/bb-distributed-table';
import type { ScopeParent } from '@aws-blocks/core';
import type {
	AsyncJobContext,
	AsyncJobOptions,
	SubmitOptions,
	AsyncJobStatus,
	WaitUntilCompleteOptions,
} from './types.js';
import { AsyncJobErrors, blocksError } from './errors.js';
import { STATUS_TABLE_ID, statusTableOptions } from './status.js';

export { AsyncJobErrors } from './errors.js';
export type {
	AsyncJobContext,
	AsyncJobOptions,
	SubmitOptions,
	BatchSubmitResult,
	AsyncJobState,
	AsyncJobStatus,
	AsyncJobTransition,
	WaitUntilCompleteOptions,
} from './types.js';

/** SQS event source limits: a batch may exceed 10 only when a batching window is set. */
const MAX_BATCH_SIZE_WITHOUT_WINDOW = 10;
const MAX_BATCH_SIZE_WITH_WINDOW = 10000;
const MAX_BATCHING_WINDOW_SECONDS = 300;

/**
 * Reject event source options AWS would refuse at deploy time, so the failure
 * names the offending option at the AsyncJob call site instead of surfacing as
 * a CloudFormation error minutes into a deployment.
 */
function validateEventSourceOptions(
	id: string,
	batchSize: number,
	maxBatchingWindowSeconds: number
): void {
	// Validate the window first: the batchSize ceiling below depends on it.
	if (
		!Number.isInteger(maxBatchingWindowSeconds) ||
		maxBatchingWindowSeconds < 0 ||
		maxBatchingWindowSeconds > MAX_BATCHING_WINDOW_SECONDS
	) {
		throw blocksError(
			AsyncJobErrors.InvalidOption,
			`AsyncJob "${id}": maxBatchingWindowSeconds must be an integer between 0 and ` +
				`${MAX_BATCHING_WINDOW_SECONDS}, got: ${maxBatchingWindowSeconds}`
		);
	}

	const maxBatchSize =
		maxBatchingWindowSeconds > 0 ? MAX_BATCH_SIZE_WITH_WINDOW : MAX_BATCH_SIZE_WITHOUT_WINDOW;
	if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > maxBatchSize) {
		throw blocksError(
			AsyncJobErrors.InvalidOption,
			`AsyncJob "${id}": batchSize must be an integer between 1 and ${maxBatchSize} ` +
				`${maxBatchingWindowSeconds > 0 ? `with a ${maxBatchingWindowSeconds}s batching window` : 'when maxBatchingWindowSeconds is 0'}` +
				`, got: ${batchSize}`
		);
	}
}

export class AsyncJob<T = unknown> extends BuildingBlockScope {
	public readonly queue: Queue;
	public readonly dlq: Queue;

	getVpcRequirements(): VpcRequirements {
		return {
			interfaceEndpoints: [ec2.InterfaceVpcEndpointAwsService.SQS],
		};
	}

	constructor(scope: ScopeParent, id: string, options: AsyncJobOptions<T>) {
		super(id, { parent: scope });

		const maxRetries = options.maxRetries ?? 3;
		const batchSize = options.batchSize ?? 10;
		const maxBatchingWindowSeconds = options.maxBatchingWindowSeconds ?? 5;
		validateEventSourceOptions(this.fullId, batchSize, maxBatchingWindowSeconds);

		this.dlq = new Queue(this, 'dlq', {
			queueName: `${this.fullId}-dlq`.substring(0, 80),
			retentionPeriod: Duration.days(14),
			encryption: QueueEncryption.SQS_MANAGED,
			enforceSSL: true,
		});

		// A message's visibility clock starts when the poller receives it, which is
		// before the batching window elapses and before the handler runs — so the
		// worst-case invisibility a message needs is the window plus the handler's
		// full budget. Anything less lets SQS redeliver a message that is still
		// being processed. This is the deterministic minimum, not AWS's padded
		// recommendation of 6x the function timeout plus the window (see D-AJ-1a).
		const visibilityTimeout = SHARED_HANDLER_TIMEOUT_SECONDS + maxBatchingWindowSeconds;

		this.queue = new Queue(this, 'queue', {
			queueName: `${this.fullId}`.substring(0, 80),
			visibilityTimeout: Duration.seconds(visibilityTimeout),
			deadLetterQueue: {
				// Batching does not change per-message retry accounting: SQS tracks
				// ApproximateReceiveCount per message, and partial batch responses
				// redeliver only the failed records — so maxRetries still means
				// "attempts for this message", exactly as it did at batchSize 1.
				queue: this.dlq,
				maxReceiveCount: maxRetries,
			},
			encryption: QueueEncryption.SQS_MANAGED,
			enforceSSL: true,
		});

		this.queue.grantSendMessages(this.handler);
		registerConfig(
			this,
			`BLOCKS_QUEUE_URL_${this.fullId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`,
			this.queue.queueUrl
		);

		// Partial batch responses MUST stay on for any batchSize > 1: without them a
		// single failing record makes SQS treat the whole batch as handled and delete
		// every message in it (silent loss). The runtime handler already returns
		// `{ batchItemFailures }`, so this is never configurable.
		this.handler.addEventSource(
			new SqsEventSource(this.queue, {
				batchSize,
				reportBatchItemFailures: true,
				maxBatchingWindow: Duration.seconds(maxBatchingWindowSeconds),
			})
		);

		// Same child id and options as the runtime entry points, so the provisioned
		// table is the one JobStatusTracker resolves at request time.
		if (options.trackStatus) {
			new DistributedTable(this, STATUS_TABLE_ID, statusTableOptions as never);
		}
	}

	// ── Runtime methods are not available during CDK synth ────────────────

	getStatus(_jobId: string): Promise<AsyncJobStatus | null> {
		return synthGuard('AsyncJob', 'getStatus');
	}

	waitUntilComplete(_jobId: string, _options?: WaitUntilCompleteOptions): Promise<AsyncJobStatus> {
		return synthGuard('AsyncJob', 'waitUntilComplete');
	}
}
