// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildLogger } from '@aws-blocks/bb-logger';
import type { AssignedCompute } from '@aws-blocks/core';

/**
 * Event passed to the CronJob handler on each scheduled invocation.
 */
export interface CronJobEvent<T = void> {
	/** ISO 8601 timestamp of the scheduled invocation time. */
	scheduledTime: string;
	/** The CronJob's id (matches the `id` passed to the constructor). */
	jobName: string;
	/** Static input configured on the CronJob. `undefined` when no input is provided. */
	input: T;
}

/**
 * Configuration options for creating a CronJob.
 */
export interface CronJobOptions<T = void> {
	/**
	 * Schedule expression. Supports cron and rate formats:
	 * - Cron: `cron(0 9 * * ? *)` (daily at 9 AM)
	 * - Rate: `rate(5 minutes)`, `rate(1 hour)`, `rate(7 days)`
	 */
	schedule: string;

	/**
	 * Function to execute on each scheduled invocation.
	 * Must be idempotent — EventBridge provides at-least-once delivery.
	 */
	handler: (event: CronJobEvent<T>) => Promise<void>;

	/** Whether the schedule is active. @default true */
	enabled?: boolean;

	/** Human-readable description of what this job does. */
	description?: string;

	/**
	 * IANA timezone for cron expressions, e.g. `'America/Los_Angeles'`.
	 * Rate expressions ignore this field. @default UTC
	 */
	timezone?: string;

	/** Static payload passed to the handler on every invocation. */
	input?: T;
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;
	/**
	 * Run this job's handler on a specific compute, sized for its workload, instead
	 * of the app's default compute. Pass the handle returned by
	 * `ComputeProvider.provide()`:
	 *
	 * ```typescript
	 * const nightly = ComputeProvider.provide('nightly', { timeoutSeconds: 900, memoryMb: 2048 });
	 * new CronJob(scope, 'rollup', { schedule: 'rate(1 day)', handler: rollup, compute: nightly });
	 * ```
	 *
	 * The EventBridge schedule invokes this compute's Lambda directly, so assigning
	 * one here moves the work — and its timeout/memory budget — off the default
	 * compute. Must resolve to a Lambda compute (the only kind the scheduler can
	 * invoke today); assigning a worker-only compute fails synth. Omitted, the job
	 * runs on the default compute.
	 *
	 * Only takes effect at synth; the local mock runs every job in-process.
	 */
	compute?: AssignedCompute;
}
