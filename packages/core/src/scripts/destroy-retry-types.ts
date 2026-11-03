// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The types the destroy retry loop shares between `destroy.ts` and `sandbox-destroy.ts`.
// They name no AWS SDK type, so `destroy.ts` can carry them in its public signatures without
// loading the SDK's declarations into an app's typecheck.

/** A stack in a synthesized cloud assembly. `region` is unset for environment-agnostic stacks. */
export interface AssemblyStack {
	stackName: string;
	region?: string;
}

/** Injectable dependencies for {@link runDestroyWithRetries} — real ones in
 * `destroySandbox`, fakes in tests so the retry/empty-before-retry wiring (the
 * sev2 fix) is exercised without spawning cdk. */
export interface DestroyRetryDeps {
	/** Run one `cdk destroy` attempt; throws (or rejects) on failure. */
	runDestroy: () => void | Promise<void>;
	/**
	 * Print the CDK output retained while it was hidden by `BLOCKS_LOG_LEVEL`
	 * (see `cdk-output.ts`). Called once, just before the destroy finally fails.
	 * Default: nothing to print.
	 */
	printRetainedOutput?: () => void;
	/** Resolve the app's stacks, by stack name and Region (for bucket enumeration). */
	listStacks: () => AssemblyStack[];
	/** Empty the given stacks' versioned S3 buckets. */
	emptyBuckets: (stacks: AssemblyStack[]) => Promise<void>;
	/** Backoff between retries (VPC-ENI detach, bucket-block clearing, DeleteRestApi 429 throttle). */
	sleep: (ms: number) => Promise<void>;
	/** Backoff between retries. Default: 1min, then 2min. */
	retryDelays?: number[];
	/** What the resource is, for the success log. Default: 'Sandbox' (production passes 'Production stack'). */
	successLabel?: string;
	/**
	 * Whether the attempt that started at `attemptStartedAt` (epoch ms) failed
	 * on an AWS API throttle (e.g. DeleteRestApi 429); `previousFailureAt` is
	 * when the previous attempt failed (events up to then belong to it, not to
	 * this attempt), undefined on the first attempt. A throttled failure is
	 * retried with {@link throttleBackoff} instead of `retryDelays`; a rejection
	 * is logged and treated as "not throttled". Default: never throttled.
	 */
	isThrottled?: (stacks: AssemblyStack[], attemptStartedAt: number, previousFailureAt?: number) => Promise<boolean>;
	/** Backoff for throttled failures. Default: randomized waits of up to 1min, 2min, 4min, then 5min, within 20min of the first failure. */
	throttleBackoff?: ThrottleBackoff;
	/** Jitter source in [0, 1). Default: `Math.random`. */
	random?: () => number;
	/** Clock (epoch ms). Default: `Date.now`. */
	now?: () => number;
	/**
	 * After a failed attempt that started at `attemptStartedAt` (epoch ms), the
	 * Lambda@Edge stacks whose delete failed because CloudFront still
	 * replicates their function (see {@link edgeStacksBlockedByReplicas}). When
	 * there is one, the loop stops and says to run {@link rerunCommand} later,
	 * instead of retrying. Default: not checked.
	 */
	edgeReplicaBlocked?: (stacks: AssemblyStack[], attemptStartedAt: number) => Promise<string[]>;
	/** The command that re-runs this destroy, for the Lambda@Edge hint. Default: 'npm run sandbox:destroy'. */
	rerunCommand?: string;
}

/** Backoff for a destroy that failed on an AWS API throttle. */
export interface ThrottleBackoff {
	/** First backoff step, before jitter. Default: 1min. */
	baseMs?: number;
	/** Ceiling for one backoff step, before jitter. Default: 5min. */
	maxDelayMs?: number;
	/**
	 * No further throttle retry is scheduled once its wait would end more than
	 * this long after the first failure (the retry attempt itself runs after
	 * that). Default: 20min.
	 */
	budgetMs?: number;
}
