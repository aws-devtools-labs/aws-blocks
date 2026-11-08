// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The retry schedules of `runDestroyWithRetries` (./sandbox.ts), and the
 * longest a destroy can run with them. A module with no runtime imports, so a
 * caller that only needs the bound (a test's timeout for `sandbox:destroy` or
 * `destroy`) can load it without the rest of the scripts.
 */

import type { ThrottleBackoff } from './sandbox.js';

/** The waits before the ordinary (not throttled) retries: `DestroyRetryDeps.retryDelays`' default. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [60_000, 120_000];

/** `DestroyRetryDeps.throttleBackoff`'s defaults. */
export const THROTTLE_BACKOFF_DEFAULTS: Readonly<Required<ThrottleBackoff>> = {
	baseMs: 60_000,
	maxDelayMs: 300_000,
	budgetMs: 20 * 60_000,
};

/**
 * The longest one `runDestroyWithRetries` call with the default schedules
 * runs when no `cdk destroy` attempt takes longer than `attemptMs`. It leaves
 * out the work before the first attempt and the checks after each failed one
 * (the stack list, the throttle and Lambda@Edge lookups, emptying buckets),
 * so a caller adds its own margin for those.
 *
 * The throttle budget is measured from the first failure, and the loop only
 * stops scheduling retries once it is spent: a throttled wait never ends
 * after the budget, but an ordinary wait may start just before the budget
 * runs out, and the attempt after either wait still runs to the end. So a
 * call that hits a throttle can take the first attempt, the whole budget, the
 * longest ordinary wait and one more attempt. A call that never hits one
 * takes at most every ordinary wait and one attempt more than there are
 * waits, which is longer only for attempts close to the budget itself.
 */
export function maxDestroyRetryMs(attemptMs: number): number {
	const longestWait = Math.max(...DEFAULT_RETRY_DELAYS_MS);
	const withThrottle = attemptMs + THROTTLE_BACKOFF_DEFAULTS.budgetMs + longestWait + attemptMs;
	const ordinaryOnly =
		(DEFAULT_RETRY_DELAYS_MS.length + 1) * attemptMs + DEFAULT_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
	return Math.max(withThrottle, ordinaryOnly);
}
