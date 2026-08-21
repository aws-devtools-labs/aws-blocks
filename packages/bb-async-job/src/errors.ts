// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Error name constants for AsyncJob operations.
 */
export const AsyncJobErrors = {
	/** Thrown when serialized payload exceeds 256 KB. */
	PayloadTooLarge: 'PayloadTooLargeException',
	/** Thrown when batch is empty (must contain at least 1 payload). */
	BatchEmpty: 'BatchEmptyException',
	/** Thrown when batch contains more than 10 payloads. */
	BatchTooLarge: 'BatchTooLargeException',
	/** Thrown when schema validation fails. */
	ValidationFailed: 'ValidationFailedException',
	/** Thrown when one or more messages in a batch fail to send (AWS only). */
	BatchSubmitFailed: 'BatchSubmitFailedException',
	/** Thrown when `waitUntilComplete()` gives up before the job reaches a terminal state. */
	Timeout: 'AsyncJobTimeoutException',
	/** Thrown when `getStatus()` or `waitUntilComplete()` is called on a job created without `trackStatus: true`. */
	StatusNotTracked: 'StatusNotTrackedException',
	/** Thrown at synth time when an `AsyncJobOptions` value is outside its supported range. */
	InvalidOption: 'InvalidOptionException',
} as const;

/** Build a typed `AsyncJob` error whose `name` is one of {@link AsyncJobErrors}. */
export function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}
