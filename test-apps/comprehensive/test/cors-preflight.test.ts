// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { testBaseUrl } from './api-url.js';
import type { api as apiType } from 'aws-blocks';

const getBaseUrl = testBaseUrl;

/** The dev server and API Gateway are separate responders; CI runs this per env. */
export function corsPreflightTests(_getApi: () => typeof apiType) {
  describe('CORS preflight allow-list', () => {
    test('preflight allows Content-Type, Authorization and the client user-agent header', async () => {
      const baseUrl = getBaseUrl();
      const resp = await fetch(`${baseUrl}/aws-blocks/api`, {
        method: 'OPTIONS',
        headers: {
          // The frontend origin: a non-allowlisted one is rejected before the preflight.
          origin: 'http://localhost:3000',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,authorization,x-blocks-user-agent',
        },
      });
      assert.strictEqual(resp.status, 200);
      const allowed = (resp.headers.get('access-control-allow-headers') ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase());
      assert.ok(allowed.includes('content-type'), `missing content-type in ${allowed}`);
      assert.ok(allowed.includes('authorization'), `missing authorization in ${allowed}`);
      assert.ok(
        allowed.includes('x-blocks-user-agent'),
        `missing x-blocks-user-agent in ${allowed}`,
      );
    });
  });
}
