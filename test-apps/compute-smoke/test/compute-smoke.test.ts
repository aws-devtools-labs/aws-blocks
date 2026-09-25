// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compute Smoke Tests — validates container-backed `Compute` + `AsyncJob` work
 * end to end in a VPC, by calling API methods through direct HTTP/RPC.
 *
 * Exercises the multi-compute path: a `Compute({ type: 'container' })` (Fargate)
 * backs an AsyncJob; submitting drains through an owner-matched SQS poller the
 * container self-starts, and the handler reaches Blocks resources (KVStore +
 * FileBucket) from the container. A second job proves the per-handler wall-clock
 * limit is ENFORCED by hard-terminating the worker thread.
 *
 * Local mode can't exercise a real container, so it skips (like vpc-smoke) —
 * the deployed run is the meaningful proof.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const isDeployed = ENV === 'sandbox' || ENV === 'production';
const __dirname = dirname(fileURLToPath(import.meta.url));
const backendPath = join(__dirname, '..', 'aws-blocks', 'index.cdk.ts');
const outputsPath = join(__dirname, '..', '.blocks-sandbox', 'outputs.json');

let apiUrl: string;

/** Call an API method via the Blocks JSON-RPC protocol. */
async function rpc(method: string, ...args: unknown[]): Promise<unknown> {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: `api.${method}`, params: args, id: 1 }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { error?: { message?: string }; result?: unknown; data?: unknown };
  if (json.error) throw new Error(`RPC ${method} error: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result ?? json.data;
}

const RESULT_POLL_INTERVAL_MS = 250;
// Deployed runs pay for SQS long-poll, the container's poll cadence, and — on a
// cold service — Fargate task startup + image pull, so the budget is generous.
const RESULT_POLL_BUDGET_MS = 120_000;

async function pollForResult<T>(fetchOne: () => Promise<T | null>): Promise<T | null> {
  const deadline = Date.now() + RESULT_POLL_BUDGET_MS;
  let result: T | null = null;
  do {
    result = await fetchOne();
    if (result) break;
    await sleep(RESULT_POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  return result;
}

test('Compute Smoke Tests', async (t) => {
  if (!isDeployed) {
    // Local can't run a real container (a CPU busy-loop can't be worker-terminated
    // in-process and would freeze the dev server). Skip cleanly — no process.exit,
    // which would force-kill the whole runner.
    t.skip('Compute smoke tests require deployment — skipping in local mode.');
    return;
  }

  t.before(async () => {
    console.log(`🚀 Deploying ${ENV}...\n`);
    execFileSync('npx', ['tsx', 'test/sandbox-deploy.ts', backendPath], {
      cwd: join(__dirname, '..'),
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    console.log('\n✅ Deployed\n');

    const outputs = JSON.parse(readFileSync(outputsPath, 'utf-8'));
    apiUrl = outputs.ApiUrl || outputs.apiUrl;
    if (!apiUrl) {
      const stackKey = Object.keys(outputs)[0];
      apiUrl = outputs[stackKey]?.ApiUrl || outputs[stackKey]?.apiUrl;
    }
    if (!apiUrl) throw new Error(`No ApiUrl found in ${outputsPath}: ${JSON.stringify(outputs)}`);
    console.log(`📡 API URL: ${apiUrl}\n`);
  });

  t.after(async () => {
    if (!process.env.BLOCKS_SANDBOX_KEEP) {
      console.log(`\n🗑️  Destroying ${ENV} stack...`);
      try {
        execFileSync('npx', ['tsx', 'test/sandbox-destroy.ts', backendPath], {
          cwd: join(__dirname, '..'),
          stdio: 'inherit',
          env: { ...process.env, NODE_OPTIONS: '' },
        });
        console.log('✅ Stack destroyed');
      } catch {
        console.log('⚠️  Stack destroy failed (non-fatal — cleanup will be retried next run)');
      }
    }
  });

  await t.test('container job — successful dispatch, invocation, and Blocks-resource access', async () => {
    const testId = Date.now().toString(36);
    const key = `ctr-${testId}`;

    const submit = (await rpc('containerJobSubmit', key, 'hello-from-container')) as { jobId: string };
    assert.ok(typeof submit.jobId === 'string' && submit.jobId.length > 0, 'submit returns a job id');

    // KVStore result proves the handler ran.
    const result = (await pollForResult(
      () => rpc('containerJobGetResult', key) as Promise<{ value: string; jobId: string; runtime: string } | null>,
    )) as { value: string; jobId: string; runtime: string } | null;
    assert.ok(result, 'container handler should have written the KVStore result');
    assert.strictEqual(result.value, 'hello-from-container');
    assert.strictEqual(result.jobId, submit.jobId);
    // The handler must have run ON the container (not Lambda).
    assert.strictEqual(result.runtime, 'container', 'handler ran on the container runtime');

    // FileBucket artifact proves the container reached a SECOND Blocks resource.
    const artifact = (await pollForResult(
      () => rpc('containerJobGetArtifact', key) as Promise<{ value: string } | null>,
    )) as { value: string } | null;
    assert.ok(artifact, 'container handler should have written the FileBucket artifact');
    assert.strictEqual(artifact.value, 'hello-from-container');
  });

  await t.test('container job — non-cooperative handler is force-terminated at the wall-clock limit', async () => {
    const testId = Date.now().toString(36);
    const key = `ctr-timeout-${testId}`;

    const submit = (await rpc('containerTimeoutJobSubmit', key)) as { jobId: string };
    assert.ok(typeof submit.jobId === 'string' && submit.jobId.length > 0);

    // The handler busy-loops ~60s but the job's limit is 3s. If the timeout were
    // merely cooperative, this non-cooperative loop would run to completion and
    // write the "completed" marker. Because the worker thread is hard-terminated
    // at 3s, the marker is never written. Wait past the limit (and a couple redrive
    // cycles) and assert it never completed.
    await sleep(30_000);
    const result = await rpc('containerTimeoutJobGetResult', key);
    assert.strictEqual(
      result,
      null,
      'a non-cooperative handler exceeding the wall-clock limit must be terminated, not allowed to complete',
    );
  });
});
