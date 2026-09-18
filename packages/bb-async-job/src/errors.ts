// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BatchSubmitResult } from './types.js';

/**
 * Error name constants for AsyncJob operations.
 */
export const AsyncJobErrors = {
	/** Thrown when serialized payload exceeds 256 KB. */
	PayloadTooLarge: 'PayloadTooLargeException',
	/** Thrown when batch is empty (must contain at least 1 payload). */
	BatchEmpty: 'BatchEmptyException',
	/** Thrown when a batch exceeds the per-call payload soft cap (10,000). */
	BatchTooLarge: 'BatchTooLargeException',
	/** Thrown when schema or submission-option validation fails. */
	ValidationFailed: 'ValidationFailedException',
	/** Thrown when one or more messages in a batch fail to send (AWS only). */
	BatchSubmitFailed: 'BatchSubmitFailedException',
	/** Thrown when `waitUntilComplete()` gives up before the job reaches a terminal state. */
	Timeout: 'AsyncJobTimeoutException',
	/** Thrown when `getStatus()` or `waitUntilComplete()` is called on a job created without `trackStatus: true`. */
	StatusNotTracked: 'StatusNotTrackedException',
	/** Thrown at synth time when an `AsyncJobOptions` value is outside its supported range. */
	InvalidOption: 'InvalidOptionException',
	/** Thrown at synth time when the resolved compute is not a supported type (only Lambda today). */
	UnsupportedCompute: 'UnsupportedComputeException',
} as const;

/**
 * Build a typed error whose `name` is one of {@link AsyncJobErrors}. Re-exported
 * from core so every block shares one implementation (single source of the
 * name-as-contract rule) rather than a per-package copy.
 */
export { blocksError } from '@aws-blocks/core';

/**
 * Thrown by `submitBatch` when one or more messages fail to enqueue (AWS only).
 *
 * A multi-chunk submit is not atomic (see DESIGN.md D-AJ-4a), so this carries
 * the partial result: `jobIds` holds the SQS MessageId for every entry that was
 * enqueued, with `null` at each failed index, and `failed` lists every failure
 * across all chunks, sorted by index. A caller can catch this and retry only
 * the `null` indexes rather than re-submitting the whole batch.
 */
export class BatchSubmitFailedError extends Error {
	override readonly name = AsyncJobErrors.BatchSubmitFailed;
	readonly jobIds: Array<string | null>;
	readonly failed: BatchSubmitResult['failed'];

	constructor(message: string, jobIds: Array<string | null>, failed: BatchSubmitResult['failed']) {
		super(`${AsyncJobErrors.BatchSubmitFailed}: ${message}`);
		this.jobIds = jobIds;
		this.failed = failed;
	}
}
