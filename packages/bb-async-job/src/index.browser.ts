// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub - AsyncJob runs server-side only
export class AsyncJob {
	constructor(...args: any[]) {}
}

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
