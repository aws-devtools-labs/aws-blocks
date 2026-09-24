// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { BuildingBlockScope } from '@aws-blocks/core/cdk';
import { registerConfig, synthGuard, SHARED_HANDLER_TIMEOUT_SECONDS } from '@aws-blocks/core/cdk';
import { resolvePerInstanceConcurrency } from '@aws-blocks/core';
import { DistributedTable } from '@aws-blocks/bb-distributed-table';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import { ContainerCompute } from '@aws-blocks/bb-container-compute/cdk';
import { sanitizeConfigKey } from '@aws-blocks/core/bb-utils';
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

	constructor(scope: ScopeParent, id: string, options: AsyncJobOptions<T>) {
		super(id, { parent: scope, vpc: { interfaceEndpoints: [ec2.InterfaceVpcEndpointAwsService.SQS] } });

		// Assign the requested compute (if any) before anything reads `this.compute`
		// below. `_compute` is the framework's internal per-scope assignment slot;
		// the public option is typed as the opaque ComputeHandle, so the cast to the
		// concrete Compute is framework plumbing (the value is always a real Compute
		// under --conditions=cdk).
		if (options.compute) {
			this._compute = options.compute as unknown as NonNullable<typeof this._compute>;
		}

		const maxRetries = options.maxRetries ?? 3;
		const batchSize = options.batchSize ?? 10;
		const maxBatchingWindowSeconds = options.maxBatchingWindowSeconds ?? 5;
		validateEventSourceOptions(this.fullId, batchSize, maxBatchingWindowSeconds);

		// A AsyncJob's queue must be consumed by exactly one runtime. On a Lambda
		// compute that's a native SQS event source (below); on a container compute
		// the container's runtime self-starts an owner-matched poller (see
		// index.aws.ts) — no event source is wired here. Any other compute type has
		// no consumption path yet, so fail loud at synth rather than provision a
		// queue nothing drains (submitted jobs would silently pile up). The brand
		// checks (not `instanceof`) survive duplicate compute-package copies in one
		// dependency tree.
		const compute = this.compute;
		const onLambda = LambdaCompute.isLambdaCompute(compute);
		const onContainer = ContainerCompute.isContainerCompute(compute);
		if (!onLambda && !onContainer) {
			throw blocksError(
				AsyncJobErrors.UnsupportedCompute,
				`AsyncJob "${this.fullId}" supports only a Lambda or container compute.`,
			);
		}

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

		this.queue.grantSendMessages(this.executionRole);
		// Config entries load into `process.env` at runtime (loadConfigToProcessEnv),
		// so keys must be valid env var names. `sanitizeConfigKey` is the single
		// shared rule the runtime reader must also use, so the writer and reader
		// reconstruct a byte-identical key (see index.aws.ts).
		const idKey = sanitizeConfigKey(this.fullId);
		registerConfig(this, `BLOCKS_QUEUE_URL_${idKey}`, this.queue.queueUrl);
		// Phase-2 owner-match seam: records which compute owns this handler. Nothing
		// reads it until the container poller lands; same sanitized key so that
		// future reader matches.
		registerConfig(this, `BLOCKS_HANDLER_OWNER_${idKey}`, compute.fullId);

		// The event source attaches to the compute's own function (guaranteed a
		// Lambda compute by the guard above).
		//
		// Partial batch responses MUST stay on for any batchSize > 1: without them a
		// single failing record makes SQS treat the whole batch as handled and delete
		// every message in it (silent loss). The runtime handler already returns
		// `{ batchItemFailures }`, so this is never configurable.
		if (onLambda) {
			compute.fn.addEventSource(
				new SqsEventSource(this.queue, {
					batchSize,
					reportBatchItemFailures: true,
					maxBatchingWindow: Duration.seconds(maxBatchingWindowSeconds),
				})
			);
		} else {
			// Container path: the runtime self-starts an owner-matched poller (no
			// native event source). Grant the shared task role permission to
			// receive, delete, and change-visibility on this queue — the poller does
			// all three (delete-on-success + visibility heartbeat for long jobs). The
			// DLQ redrive is enforced by SQS via the queue's redrive policy.
			this.queue.grantConsumeMessages(this.executionRole);

			// Per-delivery wall-clock limit (the job's own timeoutSeconds), enforced
			// by the container poller terminating the job's worker thread.
			if (options.timeoutSeconds !== undefined) {
				registerConfig(this, `BLOCKS_HANDLER_TIMEOUT_${idKey}`, String(options.timeoutSeconds));
			}

			// Per-instance concurrency = maxConcurrencyPerCPU × the compute's vCPU,
			// rounded up, floored at one. Resolved at synth against the compute's
			// vcpu so the runtime reads a concrete count.
			if (options.maxConcurrencyPerCPU !== undefined) {
				const vcpu = compute.vcpu ?? 1;
				const perInstance = resolvePerInstanceConcurrency(options.maxConcurrencyPerCPU, vcpu);
				registerConfig(this, `BLOCKS_HANDLER_CONCURRENCY_${idKey}`, String(perInstance));
			}

			// Let the container's queue-depth autoscaling see this queue.
			(compute as ContainerCompute).registerOwnedQueue(this.queue);
		}

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
