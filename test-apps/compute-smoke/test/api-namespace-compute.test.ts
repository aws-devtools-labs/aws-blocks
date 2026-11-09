// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * An API namespace on its own compute: `reports` runs on a serverless `Compute`
 * (512 MB) and must be served by that compute's function when called through the
 * front door, exactly as the typed client calls it — `POST {ApiUrl}/{export name}`.
 * `api` stays on the default compute. On the leg with
 * `strictNamespacePlacement`, the bare endpoint refuses `reports` instead of
 * running it on the default compute.
 *
 * Applies to every front door.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { ApiNamespaceClient } from '@aws-blocks/blocks/client';
import { METHOD_NOT_FOUND, rpcCall, type ComputeTestContext } from './context.js';

type WhereAmI = { functionName: string | null; memoryMb: string | null };

/** The client endpoint's host for each front door. */
const FRONT_DOOR_HOST = {
  apigateway: /\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/,
  cloudfront: /\.cloudfront\.net$/,
} as const;

export function apiNamespaceComputeTests(ctx: ComputeTestContext) {
  /** The real typed client, pointed at the front door — what a customer's frontend runs. */
  const whereAmI = (namespace: string) =>
    ApiNamespaceClient<{ whereAmI(): Promise<WhereAmI> }>(namespace, { url: ctx.apiUrl() }).whereAmI();

  describe('API namespace on its own compute', () => {
    test(`clients are given the ${ctx.frontDoor} front door's domain`, () => {
      const host = new URL(ctx.apiUrl()).hostname;
      assert.match(host, FRONT_DOOR_HOST[ctx.frontDoor], `ApiUrl host: ${host}`);
    });

    test('a namespace on its own compute is served by that compute', async () => {
      const onDefault = await whereAmI('api');
      const onReports = await whereAmI('reports');
      assert.ok(onDefault.functionName && onReports.functionName, 'both calls ran on Lambda');
      assert.notStrictEqual(onReports.functionName, onDefault.functionName, 'different functions');
      assert.strictEqual(onReports.memoryMb, '512', "the reports compute's memory option applies");
      assert.notStrictEqual(onDefault.memoryMb, '512', 'the default compute keeps its own size');
    });

    if (ctx.strictNamespacePlacement) {
      test('strict placement: the bare endpoint refuses a namespace placed on its own compute', async () => {
        // `reports` and `placedOverrideApi` (also on the reports compute) are placed
        // elsewhere, so the default compute answers "method not found" for them.
        for (const method of ['reports.whereAmI', 'placedOverrideApi.whereAmI', 'placedApi.whereAmI']) {
          const reply = await rpcCall(ctx.apiUrl(), method);
          assert.strictEqual(reply.error?.code, METHOD_NOT_FOUND, method);
          assert.strictEqual(reply.result, undefined, method);
        }
      });

      test('strict placement: a placed namespace still answers on its own path', async () => {
        const onReports = (await rpcCall(ctx.apiUrl(), 'reports.whereAmI', [], 'reports')).result as WhereAmI;
        assert.strictEqual(onReports.memoryMb, '512', 'the reports compute served it');
        // The typed client calls the same path.
        assert.strictEqual((await whereAmI('reports')).memoryMb, '512');
      });

      test('strict placement: the bare endpoint still serves the default compute\'s namespace', async () => {
        const bare = (await rpcCall(ctx.apiUrl(), 'api.whereAmI')).result as WhereAmI;
        const onPath = await whereAmI('api');
        assert.ok(bare.functionName, 'a Lambda function served it');
        assert.strictEqual(bare.functionName, onPath.functionName, 'the default compute served it');
      });
    } else {
      test('a call to the bare endpoint runs on the default compute', async () => {
        // Raw HTTP callers, and native clients released before per-namespace paths,
        // POST every call to the bare `/aws-blocks/api`: it dispatches by the body, on
        // the default compute, even for a namespace that has its own.
        const onDefault = await whereAmI('api');
        const reply = await rpcCall(ctx.apiUrl(), 'reports.whereAmI');
        const served = reply.result as WhereAmI;
        assert.strictEqual(served.functionName, onDefault.functionName, 'the default compute served it');
        assert.notStrictEqual(served.memoryMb, '512');
      });
    }

    test('a path naming a different namespace than the body is rejected', async () => {
      // The path names `reports`, the body asks for `api.whereAmI`: neither is run.
      // (That `/reports` reaches the reports compute is proven by the previous test.)
      const reply = await rpcCall(ctx.apiUrl(), 'api.whereAmI', [], 'reports');
      assert.strictEqual(reply.error?.code, -32600);
      assert.strictEqual(reply.error?.data?.name, 'InvalidRequest');
    });
  });
}
