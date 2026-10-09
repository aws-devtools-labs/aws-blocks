// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

function getBaseUrl(): string {
  const config = JSON.parse(readFileSync('.blocks-sandbox/config.json', 'utf-8'));
  const apiUrl: string = config.apiUrl;
  return apiUrl.replace(/\/aws-blocks\/api$/, '');
}

const isDeployed = process.env.BLOCKS_TEST_ENV === 'sandbox' || process.env.BLOCKS_TEST_ENV === 'production';

/**
 * The deployed stack's name, from the stage's own CDK outputs file.
 *
 * Mirrors `selectBackendStack` in `@aws-blocks/core/scripts` (not imported: this
 * suite runs under the `browser` condition): each stage writes its own outputs
 * file, and the backend stack is the one publishing `ApiUrl` — this app names its
 * stack itself in `aws-blocks/index.cdk.ts`, so the name is not derivable here.
 */
function getStackName(): string {
  const outputsFile = process.env.BLOCKS_TEST_ENV === 'production'
    ? '.blocks-sandbox/outputs.production.json'
    : '.blocks-sandbox/outputs.json';
  const outputs: Record<string, Record<string, string>> = JSON.parse(readFileSync(outputsFile, 'utf-8'));
  const backend = Object.entries(outputs).filter(([, values]) => typeof values?.ApiUrl === 'string');
  assert.strictEqual(backend.length, 1, `expected exactly one stack with an ApiUrl in ${outputsFile}, got ${backend.length}`);
  return backend[0][0];
}

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
