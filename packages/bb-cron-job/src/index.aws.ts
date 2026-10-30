// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncJob } from '@aws-blocks/bb-async-job';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { Logger } from '@aws-blocks/bb-logger';
import type { ScopeParent } from '@aws-blocks/core';
import { registerSdkIdentifiers, Scope } from '@aws-blocks/core';
import { CRON_RUNNER_ID, toCronJobEvent } from './runner.js';
import type { CronJobEvent, CronJobOptions } from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';

export { CronJobErrors } from './errors.js';
export type { CronJobEvent, CronJobOptions } from './types.js';

export class CronJob<T = void> extends Scope {
	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options: CronJobOptions<T>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		registerSdkIdentifiers(this.fullId, { scheduleName: `${this.fullId}`.substring(0, 64) });

		// Lambda compute: the scheduler invokes the function with a
		// `blocks.cronjob` event, routed here.
		this.registerLambdaEventHandler('blocks.cronjob', this.fullId, async (event) => {
			await options.handler(
				toCronJobEvent<T>({
					scheduledTime: event.scheduledTime,
					jobName: event.jobName,
					input: event.input,
				}),
			);
		});

		// Container compute: the scheduler sends each tick to the internal runner
		// AsyncJob's queue, which the container drains. Constructed on every
		// compute so its `fullId` matches the one synthesized; it stays inert
		// unless synth provisioned its queue (only on a container compute).
		new AsyncJob<CronJobEvent<T>>(this, CRON_RUNNER_ID, {
			handler: async (event) => options.handler(toCronJobEvent(event)),
			timeoutSeconds: options.timeoutSeconds,
			logger: options.logger,
		});
	}
}
