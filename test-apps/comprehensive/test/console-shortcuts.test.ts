// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { testBaseUrl } from './api-url.js';

const getBaseUrl = testBaseUrl;

function getStackName(): string {
  const outputs = JSON.parse(readFileSync('.blocks-sandbox/outputs.json', 'utf-8'));
  return Object.keys(outputs)[0];
}

const isDeployed = process.env.BLOCKS_TEST_ENV === 'sandbox' || process.env.BLOCKS_TEST_ENV === 'production';

export function consoleShortcutTests() {

  describe('Console shortcuts (/aws-blocks/resources, /aws-blocks/settings)', () => {

    test('GET /aws-blocks/resources — HTML locally, redirect when deployed', async () => {
      const res = await fetch(`${getBaseUrl()}/aws-blocks/resources`, { redirect: 'manual' });
      if (isDeployed) {
        const stackName = getStackName();
        assert.strictEqual(res.status, 302);
        const location = res.headers.get('location')!;
        assert.ok(location.includes('console.aws.amazon.com/resource-groups/group/'), `Expected resource groups console URL, got: ${location}`);
        assert.ok(location.includes(`${stackName}-resources`), `Expected group name to include '${stackName}-resources', got: ${location}`);
        assert.ok(location.includes('region='), `Expected region in URL, got: ${location}`);
      } else {
        assert.strictEqual(res.status, 200);
        const contentType = res.headers.get('content-type');
        assert.ok(contentType?.includes('text/html'), `Expected text/html, got: ${contentType}`);
        const body = await res.text();
        assert.ok(body.includes('.bb-data'), 'HTML should mention .bb-data');
      }
    });

    test('GET /aws-blocks/settings — HTML locally, redirect when deployed', async () => {
      const res = await fetch(`${getBaseUrl()}/aws-blocks/settings`, { redirect: 'manual' });
      if (isDeployed) {
        const stackName = getStackName();
        assert.strictEqual(res.status, 302);
        const location = res.headers.get('location')!;
        assert.ok(location.includes('console.aws.amazon.com/resource-groups/group/'), `Expected resource groups console URL, got: ${location}`);
        assert.ok(location.includes(`${stackName}-settings`), `Expected group name to include '${stackName}-settings', got: ${location}`);
        assert.ok(location.includes('region='), `Expected region in URL, got: ${location}`);
      } else {
        assert.strictEqual(res.status, 200);
        const contentType = res.headers.get('content-type');
        assert.ok(contentType?.includes('text/html'), `Expected text/html, got: ${contentType}`);
        const body = await res.text();
        assert.ok(body.includes('.bb-data/settings'), 'HTML should mention .bb-data/settings');
      }
    });

  });

}
