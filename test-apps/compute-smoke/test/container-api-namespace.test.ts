// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * An API namespace on a container compute: `containerApi` is served by the
 * `worker` container's tasks (the same tasks that run `container-job`), called
 * through the front door exactly as the typed client calls it —
 * `POST {ApiUrl}/containerApi`:
 * - `apigateway`: gateway → VPC link → the container's internal load balancer;
 * - `cloudfront`: CloudFront → VPC origin → the same load balancer, skipping the
 *   gateway (so a call can outlast the gateway's 29 s cap).
 *
 * The typed client calls it exactly as it calls a Lambda-hosted namespace, and
 * the handler sees the same request URL a Lambda handler would.
 *
 * Applies to every front door; the long-call test asserts each one's limit.
 */

import { before, describe, test } from 'node:test';
import assert from 'node:assert';
import { request } from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiNamespaceClient } from '@aws-blocks/blocks/client';
import { rpcCall, type ComputeTestContext } from './context.js';

type WhereAmI = {
  computeId: string | null;
  functionName: string | null;
  memoryMb: string | null;
  serviceMode: string | null;
  onEcsTask: boolean;
  requestUrl: string;
};
type ContainerApi = {
  whereAmI(): Promise<WhereAmI>;
  echoCookie(): Promise<{ cookie: string | null }>;
  sleep(ms: number): Promise<{ sleptMs: number }>;
};

// The stack reports deployed before the container's first task is RUNNING and
// healthy behind its load balancer; until then a call through the front door
// fails (no healthy target), so readiness is probed within this budget.
const FIRST_CALL_BUDGET_MS = 300_000;
const FIRST_CALL_RETRY_MS = 5_000;

/** Statuses the gateway or load balancer returns while no healthy target is registered yet. */
const NO_HEALTHY_TARGET_STATUSES = new Set([502, 503, 504]);

/**
 * Whether `fetch` failed before any response arrived (`TypeError: fetch failed`,
 * e.g. a reset connection). Anything else it throws is a real failure.
 */
function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

/**
 * Probe `{apiUrl}/{namespace}` with a raw JSON-RPC call until it answers with
 * anything but "no healthy target yet". The typed client doesn't surface the
 * HTTP status, so the probe can't use it to tell a cold start from a real error.
 * Returns once the namespace answers 2xx; throws at once on any other status.
 */
async function waitForHealthyTarget(apiUrl: string, namespace: string, method: string): Promise<void> {
  const deadline = Date.now() + FIRST_CALL_BUDGET_MS;
  let lastFailure = 'no attempt';
  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetch(`${apiUrl}/${namespace}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: `${namespace}.${method}`, params: [], id: 1 }),
      });
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      lastFailure = String(error);
      await sleep(FIRST_CALL_RETRY_MS);
      continue;
    }
    if (res.ok) return;
    const body = await res.text();
    if (!NO_HEALTHY_TARGET_STATUSES.has(res.status)) {
      throw new Error(`${namespace} answered ${res.status}: ${body}`);
    }
    lastFailure = `${res.status} ${body}`;
    await sleep(FIRST_CALL_RETRY_MS);
  }
  throw new Error(`${namespace} not reachable within ${FIRST_CALL_BUDGET_MS / 1000}s: ${lastFailure}`);
}

export function containerApiNamespaceTests(ctx: ComputeTestContext) {
  /** The real typed client, pointed at the front door — what a customer's frontend runs. */
  const whereAmI = (namespace: string) =>
    ApiNamespaceClient<{ whereAmI(): Promise<WhereAmI> }>(namespace, { url: ctx.apiUrl() }).whereAmI();
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
    let onContainer: WhereAmI;

    before(async () => {
      await waitForHealthyTarget(ctx.apiUrl(), 'containerApi', 'whereAmI');
      onContainer = await whereAmI('containerApi');
    });

    test('a namespace on a container compute is served by its task, not a function', () => {
      assert.strictEqual(onContainer.functionName, null, 'no Lambda function served it');
      assert.strictEqual(onContainer.serviceMode, 'worker', 'the container runtime served it');
      assert.strictEqual(onContainer.onEcsTask, true, 'it ran on an ECS task');
      assert.match(onContainer.computeId ?? '', /worker/, `computeId: ${onContainer.computeId}`);
      assert.doesNotMatch(onContainer.computeId ?? '', /slow-worker/, 'the worker container, not the slow-worker one');
    });

    test('the container handler sees the same request URL as a Lambda handler', async () => {
      const onLambda = await whereAmI('reports');
      assert.ok(onLambda.functionName, 'reports ran on Lambda');
      const containerUrl = new URL(onContainer.requestUrl);
      const lambdaUrl = new URL(onLambda.requestUrl);
      assert.strictEqual(containerUrl.origin, lambdaUrl.origin, 'same scheme and host');
      // Same path shape (including any stage prefix), differing only in the namespace segment.
      assert.match(lambdaUrl.pathname, /\/aws-blocks\/api\/reports$/);
      assert.strictEqual(containerUrl.pathname, lambdaUrl.pathname.replace(/\/reports$/, '/containerApi'));
    });

    test("sees the front door's public URL as ctx.request.url", () => {
      assert.strictEqual(onContainer.requestUrl, `${ctx.apiUrl()}/containerApi`);
    });

    test('a path naming a different namespace than the body is rejected', async () => {
      // The path names `containerApi`, the body asks for `api.whereAmI`: neither is run.
      const reply = await rpcCall(ctx.apiUrl(), 'api.whereAmI', [], 'containerApi');
      assert.strictEqual(reply.error?.code, -32600);
      assert.strictEqual(reply.error?.data?.name, 'InvalidRequest');
    });

    test('ignores the forwarded host and stage a client sends', async () => {
      // Every front door overwrites them, so ctx.request.url stays the public URL.
      const res = await post('whereAmI', [], { 'x-blocks-forwarded-host': 'attacker.example', 'x-blocks-forwarded-stage': 'evil' });
      assert.strictEqual(res.status, 200);
      const reply = (await res.json()) as { result?: WhereAmI };
      assert.strictEqual(reply.result?.requestUrl, `${ctx.apiUrl()}/containerApi`);
    });

    test('never takes the host from a client copy under another letter case', async () => {
      // A front door that overwrites only the exact name it maps could pass this one
      // through alongside its own: the container then refuses the request (400)
      // rather than pick one. Either way the attacker's host never reaches the URL.
      const res = await postWithHeaderCase('whereAmI', { 'X-Blocks-Forwarded-Host': 'attacker.example' });
      assert.ok(res.status === 200 || res.status === 400, `status ${res.status}: ${res.body}`);
      if (res.status === 200) {
        const reply = JSON.parse(res.body) as { result?: WhereAmI };
        assert.strictEqual(reply.result?.requestUrl, `${ctx.apiUrl()}/containerApi`);
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
