// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Local smoke: boots the dev server (the `npm run dev` experience) and
// exercises the same API surface the container serves on AWS.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const require = createRequire(import.meta.url);
// Resolve the tsx CLI entry so the spawn works on every platform (spawning
// `npm`/`npx` by name breaks on Windows).
const tsxCli = require.resolve('tsx/cli');

const port = 3003;
const base = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, [tsxCli, join(root, 'aws-blocks', 'scripts', 'server.ts')], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
});
child.stderr.on('data', (d) => process.stderr.write(d));

async function rpc(method: string, params: unknown[] = []) {
  const res = await fetch(`${base}/aws-blocks/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  return (await res.json()) as { result?: any; error?: any };
}

let passed = 0;
function ok(label: string) {
  passed++;
  console.log(`  âœ” ${label}`);
}

try {
  // Wait for the dev server front door.
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      const probe = await rpc('api.kvGet', ['warmup']);
      if (probe.result !== undefined || probe.error) {
        up = true;
        break;
      }
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(up, 'dev server came up');
  ok('dev server boots (npm run dev experience)');

  const put = await rpc('api.kvPut', ['greeting', 'hello-local']);
  assert.deepStrictEqual(put.result, { success: true });
  const get = await rpc('api.kvGet', ['greeting']);
  assert.strictEqual(get.result, 'hello-local');
  ok('KVStore round trip through the RPC endpoint');

  const submit = await rpc('api.submitJob', ['j1', 'payload-1']);
  assert.ok(submit.result.jobId, 'job accepted');
  let jobResult: any = null;
  for (let i = 0; i < 20; i++) {
    const res = await rpc('api.getJobResult', ['j1']);
    if (res.result) {
      jobResult = res.result;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.strictEqual(jobResult?.value, 'payload-1');
  ok('AsyncJob submitted over HTTP and consumed (hybrid event model)');

  const ping = await fetch(`${base}/ping/madurai`);
  assert.deepStrictEqual(await ping.json(), { pong: 'madurai' });
  ok('RawRoute with path params');

  console.log(`\nALL ${passed} LOCAL SMOKE CHECKS PASSED`);
} finally {
  child.kill();
}
