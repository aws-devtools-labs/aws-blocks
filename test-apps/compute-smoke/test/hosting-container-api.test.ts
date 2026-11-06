// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The container namespace through a Hosting distribution: on the `cloudfront`
 * leg, Hosting's default CloudFront door fronts the API as well (see
 * aws-blocks/index.cdk.ts), and routes `/aws-blocks/api/containerApi` straight
 * to the container's load balancer through a VPC origin of its own — with its
 * own response-headers policy and its own copy of the viewer-request function
 * that stamps the forwarded host. The typed client calls
 * `POST {HostingUrl}/aws-blocks/api/containerApi`, as a frontend served from
 * that distribution does.
 *
 * Applies to the `cloudfront` leg only: the `apigateway` leg deploys no Hosting.
 */

import { before, describe, test } from 'node:test';
import assert from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiNamespaceClient } from '@aws-blocks/blocks/client';
import type { ComputeTestContext } from './context.js';

type WhereAmI = { computeId: string | null; functionName: string | null; requestUrl: string };
type ContainerApi = {
  whereAmI(): Promise<WhereAmI>;
  sleep(ms: number): Promise<{ sleptMs: number }>;
};

/**
 * The distribution deploys alongside the managed one, but its domain can take a
 * while to resolve at the edge (and a failed lookup is cached negatively).
 */
const READY_BUDGET_MS = 300_000;

export function hostingContainerApiTests(ctx: ComputeTestContext) {
  const skip = ctx.frontDoor !== 'cloudfront' && 'Only the cloudfront leg deploys a Hosting distribution';
  /** The RPC endpoint on Hosting's distribution: the same domain the site is served from. */
  const hostingApiUrl = () => `${ctx.hostingUrl()}/aws-blocks/api`;
  const containerApi = () => ApiNamespaceClient<ContainerApi>('containerApi', { url: hostingApiUrl() });

  describe('API namespace on a container compute, through Hosting', { skip }, () => {
    before(async () => {
      const deadline = Date.now() + READY_BUDGET_MS;
      let last: unknown;
      while (Date.now() < deadline) {
        try {
          if ((await containerApi().whereAmI()).computeId) return;
        } catch (error) {
          last = error;
        }
        await sleep(10_000);
      }
      throw new Error(`containerApi not served through Hosting within ${READY_BUDGET_MS / 1000}s: ${last}`);
    });

    test('is served by the container compute', async () => {
      const served = await containerApi().whereAmI();
      assert.match(served.computeId ?? '', /worker/, `computeId: ${served.computeId}`);
      assert.doesNotMatch(served.computeId ?? '', /slow-worker/, 'the worker container, not the slow-worker one');
      assert.strictEqual(served.functionName, null, 'not a Lambda function');
    });

    test("sees the Hosting distribution's URL as ctx.request.url", async () => {
      const served = await containerApi().whereAmI();
      const url = new URL(served.requestUrl);
      // Not the managed distribution's origin (the backend's public origin, which
      // the container falls back to without a stamped host), and not the load
      // balancer's `<domain>:<port>` host that CloudFront forwards to a VPC origin.
      assert.notStrictEqual(url.origin, new URL(ctx.apiUrl()).origin, 'not the managed distribution');
      assert.strictEqual(url.port, '', `no origin port: ${served.requestUrl}`);
      assert.strictEqual(url.origin, new URL(ctx.hostingUrl()).origin);
      assert.strictEqual(served.requestUrl, `${hostingApiUrl()}/containerApi`);
    });

    test('a 35 s call completes: Hosting reaches the container directly', async () => {
      assert.deepStrictEqual(await containerApi().sleep(35_000), { sleptMs: 35_000 });
    });
  });
}
