// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { setTimeout } from 'node:timers/promises';
import type { api as apiType } from 'cdk-blocks';

export function cronJobTests(getApi: () => typeof apiType) {
  describe('CronJob BB', () => {
    test('CronJob - rate(1 minute) schedule fires and writes result', async () => {
      const api = getApi();

      // Poll for up to 90 seconds — the schedule fires every minute
      let result = null;
      for (let i = 0; i < 30; i++) {
        result = await api.cronJobGetResult('minute-cron:last');
        if (result) break;
        await setTimeout(3000);
      }

      assert.ok(result, 'minute-cron handler should have fired and written a result');
      assert.ok(result.jobName.includes('minute-cron'), `jobName should contain 'minute-cron', got '${result.jobName}'`);
      assert.ok(!isNaN(Date.parse(result.scheduledTime)), 'scheduledTime should be valid ISO 8601');
      assert.ok(result.firedAt, 'should have firedAt timestamp');
    });

    test('CronJob - disabled job does not fire', async () => {
      const api = getApi();

      // Clear any stale data from previous test runs
      await api.cronJobDeleteResult('disabled-cron:last');

      // Wait long enough that an enabled rate(1 hour) job would NOT fire,
      // but short enough that the test isn't slow.
      await setTimeout(3000);
      const result = await api.cronJobGetResult('disabled-cron:last');
      assert.strictEqual(result, null, 'disabled-cron should not have fired');
    });
  });
}
