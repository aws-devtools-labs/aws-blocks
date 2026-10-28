// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS-runtime coverage for CronJob's two delivery paths. Run under
 * `--conditions=aws-runtime` so the composed AsyncJob is its runtime entry.
 *
 * - Lambda compute: the scheduler invokes the function with a `blocks.cronjob`
 *   event, dispatched to the handler registered under the job's `fullId`.
 * - Container compute: the scheduler sends the tick to the runner AsyncJob's
 *   queue. The container's poller (or a worker thread) resolves the runner by
 *   `fullId` and runs one record; that must call the CronJob handler with the
 *   same event shape.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { getAsyncJob } from '@aws-blocks/bb-async-job/job-registry';
import { Scope } from '@aws-blocks/core';
import { sanitizeConfigKey } from '@aws-blocks/core/bb-utils';
import { CronJob } from './index.aws.js';
import type { CronJobEvent } from './types.js';

describe('CronJob (aws runtime): container delivery via the runner AsyncJob', () => {
	test('a runner record calls the handler with the scheduled event', async () => {
		const scope = new Scope(`cj-${Math.random().toString(36).slice(2)}`);
		const runnerFullId = `${scope.fullId}-nightly-runner`;
		// Synth provisions the runner queue only on a container compute, and its
		// URL reaches the runtime as config. Seed it so the runner registers.
		const envKey = `BLOCKS_QUEUE_URL_${sanitizeConfigKey(runnerFullId)}`;
		process.env[envKey] = 'https://sqs.us-east-1.amazonaws.com/000000000000/runner';

		const received: CronJobEvent<{ region: string }>[] = [];
		try {
			const job = new CronJob<{ region: string }>(scope, 'nightly', {
				schedule: 'rate(1 day)',
				handler: async (event) => {
					received.push(event);
				},
			});
			assert.strictEqual(`${job.fullId}-runner`, runnerFullId);

			const runner = getAsyncJob(runnerFullId);
			assert.ok(runner, 'runner AsyncJob is registered under its fullId');
			await runner._processRecord({
				messageId: 'm-1',
				body: JSON.stringify({
					jobName: job.fullId,
					scheduledTime: '2026-10-28T03:00:00Z',
					input: { region: 'eu' },
				}),
				attributes: { ApproximateReceiveCount: '1', SentTimestamp: String(Date.now()) },
			});
		} finally {
			delete process.env[envKey];
		}

		assert.deepStrictEqual(received, [
			{ scheduledTime: '2026-10-28T03:00:00Z', jobName: `${scope.fullId}-nightly`, input: { region: 'eu' } },
		]);
	});

	test('without a provisioned runner queue the runner stays inert', () => {
		const scope = new Scope(`cj-${Math.random().toString(36).slice(2)}`);
		new CronJob(scope, 'nightly', { schedule: 'rate(1 day)', handler: async () => {} });
		assert.strictEqual(getAsyncJob(`${scope.fullId}-nightly-runner`), undefined);
	});
});
