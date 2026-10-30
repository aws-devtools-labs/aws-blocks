// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Event passed to the CronJob handler on each scheduled invocation.
 */
import type { ChildLogger } from '@aws-blocks/bb-logger';
import type { ComputeProvider } from '@aws-blocks/core/cdk/internal';
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

	/**
	 * The compute this job's handler runs on. Omit to run on the scope's compute
	 * (see `ScopeOptions.compute`), which defaults to the app's default compute.
	 * Pass a serverless `Compute` block (or any {@link ComputeProvider}) to give
	 * the job its own function, for example more memory or a longer timeout than
	 * the API's.
	 *
	 * Only a `serverless` compute can run a CronJob for now: the schedule invokes
	 * the compute's function directly. A `container` compute is a type error, and
	 * a container inherited from the scope fails synth.
	 */
	compute?: ComputeProvider<'serverless'>;
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;
}

