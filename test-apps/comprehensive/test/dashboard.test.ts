// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { testBaseUrl } from './api-url.js';

export function dashboardTests() {
  describe('Dashboard redirects', () => {
    test('each route targets its own dashboard on AWS and reports cloud-only locally', async () => {
      const deployed = process.env.BLOCKS_TEST_ENV === 'sandbox' || process.env.BLOCKS_TEST_ENV === 'production';
      const locations: string[] = [];
      for (const id of ['ops', 'billing']) {
        const response = await fetch(`${testBaseUrl()}/${id}/dashboard`, { redirect: 'manual' });
        if (deployed) {
          assert.equal(response.status, 302);
          const location = response.headers.get('location');
          assert.ok(location);
          assert.ok(new URL(location).hash.endsWith(`-${id}-dashboard`), location);
          locations.push(location);
        } else {
          assert.equal(response.status, 503);
          assert.equal(response.headers.get('location'), null);
          const body = await response.json();
          assert.match(body.message, /cloud-only/);
        }
      }
      if (deployed) assert.notEqual(locations[0], locations[1]);
    });
  });
}
