// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildLogger } from '@aws-blocks/bb-logger';
import type { ComputeProvider } from '@aws-blocks/core/cdk/internal';

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
	 * The compute this job's handler runs on. Omit to run on the scope's compute
	 * (see `ScopeOptions.compute`), which defaults to the app's default compute.
	 * Pass a `Compute` block (or any {@link ComputeProvider}; the same objects
	 * `AsyncJob` accepts) to run the handler elsewhere: a serverless compute to
	 * give the job its own function, for example more memory or a longer timeout
	 * than the API's, or a container (AWS Fargate) compute for a job that runs
	 * longer than a serverless compute allows.
	 *
	 * On a serverless compute the schedule invokes the function directly. On a
	 * container compute each tick is sent to an internal `AsyncJob` queue that
	 * the container drains, so a tick gets the same delivery as a container
	 * `AsyncJob`: an enforced `timeoutSeconds`, up to 3 attempts, then a
	 * dead-letter queue. In local dev, compute assignment is transparent — the
	 * handler runs in-process.
	 */
	compute?: ComputeProvider;

	/**
	 * Wall-clock limit for one tick, in seconds. A property of the work, not the
	 * compute, with the same meaning as `AsyncJob`'s `timeoutSeconds`. On a
	 * container compute it is enforced by the runtime (the tick's worker is
	 * terminated at the deadline); on a serverless compute it is bounded by the
	 * function timeout. Must fit under the compute's ceiling where one exists.
	 */
	timeoutSeconds?: number;
}

