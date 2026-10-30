// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * An API namespace on a container compute: `containerApi` runs on the `worker`
 * container (the same tasks that run `container-job`), called through the front
 * door exactly as the typed client calls it — `POST {ApiUrl}/containerApi`:
 * - `apigateway`: gateway → VPC link → the container's internal load balancer;
 * - `cloudfront`: CloudFront → VPC origin → the same load balancer, skipping the
 *   gateway (so a call can outlast the gateway's 29 s cap).
 *
 * Applies to every front door; the long-call test asserts each one's limit.
 */

import { before, describe, test } from 'node:test';
import assert from 'node:assert';
import { request } from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiNamespaceClient } from '@aws-blocks/blocks/client';
import { rpcCall, type ComputeTestContext } from './context.js';

type WhereAmI = { computeId: string | null; functionName: string | null; url: string };
type ContainerApi = {
  whereAmI(): Promise<WhereAmI>;
  echoCookie(): Promise<{ cookie: string | null }>;
  sleep(ms: number): Promise<{ sleptMs: number }>;
};

/** Fargate tasks register behind the load balancer after the stack deploys. */
const READY_BUDGET_MS = 300_000;

export function containerApiTests(ctx: ComputeTestContext) {
  /** The real typed client, pointed at the front door — what a customer's frontend runs. */
  const containerApi = () => ApiNamespaceClient<ContainerApi>('containerApi', { url: ctx.apiUrl() });
  /** A raw call to the namespace's path, for what the typed client hides (headers, status). */
  const post = (method: string, params: unknown[] = [], headers: Record<string, string> = {}) =>
    fetch(`${ctx.apiUrl()}/containerApi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', method: `containerApi.${method}`, params, id: 1 }),
    });

  /**
   * `post`, but over `node:https`, which sends header names in the case given —
   * `fetch` lower-cases them, and that is the case the front doors overwrite.
   */
  const postWithHeaderCase = (method: string, headers: Record<string, string>) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', method: `containerApi.${method}`, params: [], id: 1 });
      const req = request(`${ctx.apiUrl()}/containerApi`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on('error', reject);
      req.end(body);
    });

  describe('API namespace on a container compute', () => {
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
      throw new Error(`containerApi not served within ${READY_BUDGET_MS / 1000}s: ${last}`);
    });

    test('is served by the container compute', async () => {
      const served = await containerApi().whereAmI();
      assert.match(served.computeId ?? '', /worker/, `computeId: ${served.computeId}`);
      assert.doesNotMatch(served.computeId ?? '', /slow-worker/, 'the worker container, not the slow-worker one');
      assert.strictEqual(served.functionName, null, 'not a Lambda function');
    });

    test("sees the front door's public URL as ctx.request.url", async () => {
      const served = await containerApi().whereAmI();
      assert.strictEqual(served.url, `${ctx.apiUrl()}/containerApi`);
    });

    test('ignores the forwarded host and stage a client sends', async () => {
      // Every front door overwrites them, so ctx.request.url stays the public URL.
      const res = await post('whereAmI', [], { 'x-blocks-forwarded-host': 'attacker.example', 'x-blocks-forwarded-stage': 'evil' });
      assert.strictEqual(res.status, 200);
      const reply = (await res.json()) as { result?: WhereAmI };
      assert.strictEqual(reply.result?.url, `${ctx.apiUrl()}/containerApi`);
    });

    test('never takes the host from a client copy under another letter case', async () => {
      // A front door that overwrites only the exact name it maps could pass this one
      // through alongside its own: the container then refuses the request (400)
      // rather than pick one. Either way the attacker's host never reaches the URL.
      const res = await postWithHeaderCase('whereAmI', { 'X-Blocks-Forwarded-Host': 'attacker.example' });
      assert.ok(res.status === 200 || res.status === 400, `status ${res.status}: ${res.body}`);
      if (res.status === 200) {
        const reply = JSON.parse(res.body) as { result?: WhereAmI };
        assert.strictEqual(reply.result?.url, `${ctx.apiUrl()}/containerApi`);
      }
      assert.ok(!res.body.includes('attacker.example'), res.body);
    });

    test('delivers every Set-Cookie to the client', async () => {
      const res = await post('setCookies');
      assert.strictEqual(res.status, 200);
      const names = res.headers.getSetCookie().map((c) => c.split('=')[0]).sort();
      assert.deepStrictEqual(names, ['container-a', 'container-b']);
    });

    test('hands the request cookies to the container', async () => {
      const res = await post('echoCookie', [], { Cookie: 'session=abc' });
      const reply = (await res.json()) as { result?: { cookie: string | null } };
      assert.strictEqual(reply.result?.cookie, 'session=abc');
    });

    if (ctx.frontDoor === 'cloudfront') {
      test('a 35 s call completes: CloudFront reaches the container directly', async () => {
        assert.deepStrictEqual(await containerApi().sleep(35_000), { sleptMs: 35_000 });
      });
    } else {
      test('a 35 s call is cut off by the gateway at ~29 s', async () => {
        const started = Date.now();
        const res = await post('sleep', [35_000]);
        const elapsed = (Date.now() - started) / 1000;
        assert.strictEqual(res.status, 504);
        assert.ok(elapsed > 27 && elapsed < 33, `cut off after ${elapsed.toFixed(1)}s`);
      });
    }

    test('a call to the bare endpoint runs on the default compute', async () => {
      // Raw HTTP callers, and native clients released before per-namespace paths,
      // POST to the bare `/aws-blocks/api`: it dispatches by the body, on the
      // default (Lambda) compute, even for a container namespace.
      const reply = await rpcCall(ctx.apiUrl(), 'containerApi.whereAmI');
      const served = reply.result as WhereAmI;
      assert.ok(served.functionName, 'a Lambda function served it');
      assert.strictEqual(served.computeId, null);
    });
  });
}
