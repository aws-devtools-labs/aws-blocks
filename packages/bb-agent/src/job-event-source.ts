// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * SQS event source options for the Agent's internal AsyncJob, shared by the
 * runtime (`agent.ts`) and CDK (`index.cdk.ts`) construction sites so an edit to
 * one site's numbers cannot silently miss the other. Only the CDK site's values
 * reach a real event source mapping today — the runtime entry points do not read
 * these options — so this is a single source of truth for the intent, not a
 * runtime/CDK sync guarantee.
 *
 * `stream()` submits one job per interactive turn (and a second on HITL
 * resume) while the caller is blocked on that job starting, so AsyncJob's
 * batching defaults would add up to 5s of delivery latency to a human-facing
 * path. `batchSize: 1` also keeps one failing turn out of a shared batch,
 * which matters because the handler is not idempotent.
 */
export const INTERACTIVE_JOB_EVENT_SOURCE = {
	batchSize: 1,
	maxBatchingWindowSeconds: 0,
} as const;
