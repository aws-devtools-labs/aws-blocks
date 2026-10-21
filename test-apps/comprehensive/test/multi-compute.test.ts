// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import type { api as apiType, isolatedApi as isolatedApiType } from 'aws-blocks';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';

/**
 * A namespace given its own `Compute` (`isolatedApi`, 512 MB) is served by that
 * compute's function; the rest of the API stays on the default compute. Locally
 * every namespace runs in the dev server, so only the call path is checked.
 */
export function multiComputeTests(
  getApi: () => typeof apiType,
  getIsolatedApi: () => typeof isolatedApiType,
) {
  describe('Multi-compute — ApiNamespace compute option', () => {
    test('a namespace on its own compute runs on that compute', async () => {
      const onDefault = await getApi().whereAmI();
      const onIsolated = await getIsolatedApi().whereAmI();

      if (ENV === 'local') {
        assert.strictEqual(onIsolated.pid, onDefault.pid, 'local dev runs every namespace in one process');
        return;
      }
      assert.ok(onDefault.functionName && onIsolated.functionName, 'both calls ran on Lambda');
      assert.notStrictEqual(onIsolated.functionName, onDefault.functionName, 'different functions');
      assert.strictEqual(onIsolated.memoryMb, '512', "the isolated compute's memory option applies");
      assert.notStrictEqual(onDefault.memoryMb, '512', 'the default compute keeps its own size');
    });
  });
}
