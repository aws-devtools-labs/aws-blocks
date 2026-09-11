// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncJobErrors } from './errors.js';

const MAX_DELAY_SECONDS = 900;

/**
 * Validate the per-message delay accepted by Amazon SQS.
 */
export function validateDelaySeconds(delaySeconds?: number): void {
	if (
		delaySeconds !== undefined
		&& (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_DELAY_SECONDS)
	) {
		const err = new Error(
			`${AsyncJobErrors.ValidationFailed}: \`delaySeconds\` must be an integer from 0 to ${MAX_DELAY_SECONDS} (received ${String(delaySeconds)})`,
		);
		err.name = AsyncJobErrors.ValidationFailed;
		throw err;
	}
}
