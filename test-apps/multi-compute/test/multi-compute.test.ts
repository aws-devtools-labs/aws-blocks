// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-compute behind the managed CloudFront front door (`apiFrontDoor:
 * 'cloudfront'`). A namespace given its own `Compute` must be served by that
 * compute's function when called through the distribution, exactly as the typed
 * client calls it: `POST {publicApiUrl}/{export name}`.
 *
 * Deployed only — local dev runs every namespace in one process, which the
 * comprehensive suite already covers.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiNamespaceClient } from '@aws-blocks/blocks/client';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = join(__dirname, '..');
const backendPath = join(appDir, 'aws-blocks', 'index.cdk.ts');
const outputsPath = join(appDir, '.blocks-sandbox', 'outputs.json');

type WhereAmI = { functionName: string | null; memoryMb: string | null };
type RpcReply = { result?: unknown; error?: { code?: number; message?: string; data?: { name?: string } } };

let apiUrl: string;

/** A raw JSON-RPC call to a per-namespace path (for requests the typed client never sends). */
async function rpc(pathNamespace: string, method: string): Promise<RpcReply> {
  const res = await fetch(`${apiUrl}/${pathNamespace}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params: [], id: 1 }),
  });
  assert.ok(res.ok, `${method} via /${pathNamespace}: HTTP ${res.status} ${await res.clone().text()}`);
  return (await res.json()) as RpcReply;
}

/** The real typed client, pointed at the front door — what a customer's frontend runs. */
const whereAmI = (namespace: string) =>
  ApiNamespaceClient<{ whereAmI(): Promise<WhereAmI> }>(namespace, { url: apiUrl }).whereAmI();

/**
 * A new distribution reports CREATE_COMPLETE before its domain resolves at the
 * edge, and a failed lookup is cached negatively — poll until a call succeeds.
 */
async function waitForFrontDoor(budgetMs = 300_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await whereAmI('api');
      return;
    } catch (error) {
      lastError = error;
      await sleep(5_000);
    }
  }
  throw new Error(`Front door not reachable within ${budgetMs / 1000}s: ${String(lastError)}`);
}

test('Multi-compute behind the managed CloudFront front door', async (t) => {
  if (ENV === 'local') {
    t.skip('Deployed only — local dev runs every namespace in one process.');
    return;
  }

  t.before(async () => {
    execFileSync('npx', ['tsx', 'test/sandbox-deploy.ts', backendPath], {
      cwd: appDir,
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const outputs = JSON.parse(readFileSync(outputsPath, 'utf-8')) as Record<string, Record<string, string>>;
    apiUrl = Object.values(outputs)[0]?.ApiUrl;
    if (!apiUrl) throw new Error(`No ApiUrl in ${outputsPath}: ${JSON.stringify(outputs)}`);
    console.log(`📡 API URL: ${apiUrl}`);
    await waitForFrontDoor();
  });

  t.after(() => {
    if (process.env.BLOCKS_SANDBOX_KEEP) return;
    execFileSync('npx', ['tsx', 'test/sandbox-destroy.ts', backendPath], {
      cwd: appDir,
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
  });

  await t.test('clients are given the CloudFront domain, not the gateway', () => {
    const host = new URL(apiUrl).hostname;
    assert.match(host, /\.cloudfront\.net$/, `ApiUrl host: ${host}`);
  });

  await t.test('a namespace on its own compute is served by that compute', async () => {
    const onDefault = await whereAmI('api');
    const onReports = await whereAmI('reports');
    assert.ok(onDefault.functionName && onReports.functionName, 'both calls ran on Lambda');
    assert.notStrictEqual(onReports.functionName, onDefault.functionName, 'different functions');
    assert.strictEqual(onReports.memoryMb, '512', "the reports compute's memory option applies");
    assert.notStrictEqual(onDefault.memoryMb, '512', 'the default compute keeps its own size');
  });

  await t.test('a path naming a different namespace than the body is rejected', async () => {
    // The path names `reports`, the body asks for `api.whereAmI`: neither is run.
    // (That `/reports` reaches the reports compute is proven by the previous test.)
    const reply = await rpc('reports', 'api.whereAmI');
    assert.strictEqual(reply.error?.code, -32600);
    assert.strictEqual(reply.error?.data?.name, 'InvalidRequest');
  });
});
