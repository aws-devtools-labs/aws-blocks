// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Duration } from 'aws-cdk-lib';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Scope } from '@aws-blocks/core/cdk';
import { registerConfig, synthGuard } from '@aws-blocks/core/cdk';
import { DistributedTable } from '@aws-blocks/bb-distributed-table';
import type { ScopeParent } from '@aws-blocks/core';
import type {
	AsyncJobContext,
	AsyncJobOptions,
	SubmitOptions,
	AsyncJobStatus,
	WaitUntilCompleteOptions,
} from './types.js';
import { AsyncJobErrors } from './errors.js';
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

export class AsyncJob<T = unknown> extends Scope {
	public readonly queue: Queue;
	public readonly dlq: Queue;

	constructor(scope: ScopeParent, id: string, options: AsyncJobOptions<T>) {
		super(id, { parent: scope });

		// Register VPC endpoint requirements for SQS access
		this.registerVpcRequirements({
			endpoints: [{ service: 'sqs', type: 'interface' }],
		});

		const maxRetries = options.maxRetries ?? 3;
		const batchSize = options.batchSize ?? 1;

		this.dlq = new Queue(this, 'dlq', {
			queueName: `${this.fullId}-dlq`.substring(0, 80),
			retentionPeriod: Duration.days(14),
			encryption: QueueEncryption.SQS_MANAGED,
			enforceSSL: true,
		});

		// Visibility timeout must be >= the shared Lambda's timeout (900s)
		const visibilityTimeout = 900;

		this.queue = new Queue(this, 'queue', {
			queueName: `${this.fullId}`.substring(0, 80),
			visibilityTimeout: Duration.seconds(visibilityTimeout),
			deadLetterQueue: {
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

		this.handler.addEventSource(new SqsEventSource(this.queue, { batchSize }));

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
