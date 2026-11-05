// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * An API namespace on a container compute: `containerApi` is served by the
 * `worker` container's tasks, reached from the front door through the gateway's
 * VPC link and the compute's internal load balancer. The typed client calls it
 * exactly as it calls a Lambda-hosted namespace — `POST {ApiUrl}/{export name}` —
 * and the handler sees the same request URL a Lambda handler would.
 *
 * Applies to every front door.
 */

import { before, describe, test } from 'node:test';
import assert from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiNamespaceClient } from '@aws-blocks/blocks/client';
import { rpcCall, type ComputeTestContext } from './context.js';

type WhereAmI = {
  functionName: string | null;
  memoryMb: string | null;
  serviceMode: string | null;
  onEcsTask: boolean;
  requestUrl: string;
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

    test('a path naming a different namespace than the body is rejected', async () => {
      // The path names `containerApi`, the body asks for `api.whereAmI`: neither is run.
      const reply = await rpcCall(ctx.apiUrl(), 'api.whereAmI', [], 'containerApi');
      assert.strictEqual(reply.error?.code, -32600);
      assert.strictEqual(reply.error?.data?.name, 'InvalidRequest');
    });
  });
}
