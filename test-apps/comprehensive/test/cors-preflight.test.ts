// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import type { api as apiType } from 'aws-blocks';

function getBaseUrl(): string {
  const config = JSON.parse(readFileSync('.blocks-sandbox/config.json', 'utf-8'));
  const apiUrl: string = config.apiUrl;
  return apiUrl.replace(/\/aws-blocks\/api$/, '');
}

/** Local and sandbox are separate preflight responders, so both are covered. */
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
