// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { sanitizeConfigKey } from '@aws-blocks/core/bb-utils';
import type { CronJobEvent } from './types.js';

/**
 * Child id of the internal `AsyncJob` that delivers a CronJob's ticks on a
 * container compute. The CDK and runtime entries both construct the child under
 * this id, so its `fullId` (and with it the queue, config keys, and handler
 * registration) matches across synth and runtime.
 *
 * @internal
 */
export const CRON_RUNNER_ID = 'runner';

/**
 * Config key the CDK entry registers only when it creates this CronJob's
 * runner (a container compute). The runtime entry builds the runner only when
 * the key is set, so a serverless CronJob never constructs a child that could
 * share a `fullId` (`<cronFullId>-runner`) with a user's own AsyncJob.
 *
 * @internal
 */
export function cronRunnerConfigKey(cronFullId: string): string {
	return `BLOCKS_CRON_RUNNER_${sanitizeConfigKey(cronFullId)}`;
}

/**
 * Normalize a scheduler payload into the event the handler receives. EventBridge
 * fills `<aws.scheduler.scheduled-time>`; the fallback only covers a payload
 * sent by hand without it.
 *
 * @internal
 */
export function toCronJobEvent<T>(
	event: Omit<CronJobEvent<T>, 'scheduledTime'> & { scheduledTime?: string },
): CronJobEvent<T> {
	return {
		scheduledTime: event.scheduledTime ?? new Date().toISOString(),
		jobName: event.jobName,
		input: event.input,
	};
}
