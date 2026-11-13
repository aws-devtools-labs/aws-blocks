// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * VPC Smoke Tests — validates each BB can reach its backing service from
 * within a VPC by calling API methods through direct HTTP/RPC.
 *
 * While this suite's scripts only echo (issue #987), the comprehensive app
 * carries `secretRotation: true` so the rotating path still gets a deploy. Drop
 * that option from `test-apps/comprehensive/aws-blocks/index.ts` when these
 * scripts run again: a rotation Lambda's network interfaces hold that lane's
 * teardown for minutes.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const __dirname = dirname(fileURLToPath(import.meta.url));
const backendPath = join(__dirname, '..', 'aws-blocks', 'index.cdk.ts');
// Each stage writes its own CDK outputs document (core's `OUTPUTS_FILE`), so a
// production run must not read the sandbox's.
const outputsPath = join(
  __dirname,
  '..',
  '.blocks-sandbox',
  ENV === 'production' ? 'outputs.production.json' : 'outputs.json',
);

let apiUrl: string;

/** Call an API method via the Blocks JSON-RPC protocol */
async function rpc(method: string, ...args: unknown[]): Promise<unknown> {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: "2.0", method: `api.${method}`, params: args, id: 1 }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: ${res.status} ${await res.text()}`);
  const json = await res.json() as any;
  if (json.error) throw new Error(`RPC ${method} error: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result ?? json.data;
}

test('VPC Smoke Tests', async (t) => {
  if (ENV === 'local') {
    // Local runs can't exercise VPC connectivity — skip cleanly (no process.exit,
    // which would force-kill the whole test runner) so the rest of the suite runs.
    t.skip('VPC smoke tests require deployment — skipping in local mode.');
    return;
  }

  t.before(async () => {
    console.log(`🚀 Deploying ${ENV}...\n`);
    execFileSync('npx', ['tsx', 'test/sandbox-deploy.ts', backendPath], {
      cwd: join(__dirname, '..'), stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' },
    });
    console.log('\n✅ Deployed\n');

    // Read API URL from sandbox outputs
    const outputs = JSON.parse(readFileSync(outputsPath, 'utf-8'));
    apiUrl = outputs.ApiUrl || outputs.apiUrl;
    if (!apiUrl) {
      // Try nested format
      const stackKey = Object.keys(outputs)[0];
      apiUrl = outputs[stackKey]?.ApiUrl || outputs[stackKey]?.apiUrl;
    }
    if (!apiUrl) throw new Error(`No ApiUrl found in ${outputsPath}: ${JSON.stringify(outputs)}`);
    console.log(`📡 API URL: ${apiUrl}\n`);
  });

  t.after(async () => {
    if ((ENV === 'sandbox' || ENV === 'production') && !process.env.BLOCKS_SANDBOX_KEEP) {
      console.log(`\n🗑️  Destroying ${ENV} stack...`);
      try {
        execFileSync('npx', ['tsx', 'test/sandbox-destroy.ts', backendPath], {
          cwd: join(__dirname, '..'), stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' },
        });
        console.log(`✅ Stack destroyed`);
      } catch {
        console.log(`⚠️  Stack destroy failed (non-fatal — cleanup will be retried next run)`);
      }
    }
  });

  await t.test('KVStore: put + get via DynamoDB gateway endpoint', async () => {
    const key = `vpc-smoke-${Date.now()}`;
    const result = await rpc('kvPutGet', key, 'hello-vpc');
    assert.strictEqual(result, 'hello-vpc');
  });

  await t.test('DistributedTable: put + query via DynamoDB gateway endpoint', async () => {
    const pk = `vpc-smoke-${Date.now()}`;
    const items = await rpc('tablePutQuery', pk, 'item-1', 'vpc-test-data') as any[];
    assert.ok(items.length >= 1);
    assert.strictEqual(items[0].data, 'vpc-test-data');
  });

  await t.test('FileBucket: put + get via S3 gateway endpoint', async () => {
    const key = `vpc-smoke-${Date.now()}.txt`;
    const result = await rpc('filePutGet', key, 'vpc file content');
    assert.strictEqual(result, 'ok');
  });

  await t.test('AsyncJob: submit via SQS interface endpoint', async () => {
    const result = await rpc('jobSubmit', 'vpc-smoke-test');
    assert.strictEqual(result, 'submitted');
  });

  await t.test('AppSetting: get via SSM interface endpoint', async () => {
    const value = await rpc('settingGet');
    assert.ok(value !== null && value !== undefined);
  });

  await t.test('Realtime: publish via API Gateway interface endpoint', async () => {
    const result = await rpc('realtimePublish', 'vpc-test-channel', 'connectivity check');
    assert.strictEqual(result, 'published');
  });

  await t.test('Database (Aurora): query via Secrets Manager + RDS Data API endpoints', async () => {
    const result = await rpc('dbQuery') as any[];
    assert.ok(result.length >= 1);
    assert.strictEqual(result[0].ping, 1);
  });

  // Rotation in a shared VPC: the Database registers its rotation Lambda's
  // security group and core admits it on the endpoint security group every
  // Blocks-managed interface endpoint shares. Synth cannot prove the two blocks
  // met, so read the deployed groups back.
  await t.test('Database (Aurora): a rotation finished and its security group is admitted on the shared endpoint', () => {
    const outputs = JSON.parse(readFileSync(outputsPath, 'utf-8')) as Record<string, Record<string, string>>;
    const stack = Object.keys(outputs)[0];
    const aws = (...args: string[]) => execFileSync('aws', args, { encoding: 'utf-8' }).trim();
    // list-stack-resources pages; describe-stack-resources caps at 100 and takes
    // no pagination token. This stack is over that cap, so a lookup against it
    // can miss the groups below.
    const groups = aws(
      'cloudformation', 'list-stack-resources', '--stack-name', stack,
      '--query', "StackResourceSummaries[?ResourceType=='AWS::EC2::SecurityGroup'].[LogicalResourceId,PhysicalResourceId]",
      '--output', 'text',
    );
    // Exactly one match, or fail naming what was found: a lookup that returned
    // `undefined` would leave the comparisons below asserting nothing.
    const idOf = (needle: string) => {
      const hits = groups.split('\n').map((l) => l.split('\t')).filter(([logical]) => logical.includes(needle));
      assert.strictEqual(
        hits.length,
        1,
        `exactly one ${needle} security group in ${stack}, got ${hits.length}:\n${groups}`,
      );
      return hits[0][1];
    };
    const rotationSg = idOf('RotationSg');
    const endpointSg = idOf('BlocksVpcEndpointSg');

    const admitted = aws(
      'ec2', 'describe-security-groups', '--group-ids', endpointSg,
      '--query', 'SecurityGroups[0].IpPermissions[?FromPort==`443`].UserIdGroupPairs[].GroupId',
      '--output', 'text',
    );
    assert.ok(admitted.includes(rotationSg), `endpoint SG ${endpointSg} admits ${rotationSg} on 443: got ${admitted}`);

    // Rotation evidence comes from the stack's own output, not Secrets Manager: a
    // schedule existing proves nothing, and the CI role that can describe a stack
    // cannot describe a secret. bb-data outputs what its deploy-time wait saw.
    const waited = Object.entries(outputs[stack])
      .filter(([key]) => /RotationWaited([0-9A-F]{8})?$/.test(key))
      .map(([, value]) => value);
    assert.strictEqual(
      waited.length,
      1,
      `exactly one RotationWaited output in ${stack}, got ${waited.length}: ${Object.keys(outputs[stack]).join(', ')}`,
    );
    assert.strictEqual(waited[0], 'true', `the deploy's wait saw the rotation finish: ${waited[0]}`);
  });

  await t.test('Logger: emit via CloudWatch Logs endpoint', async () => {
    const result = await rpc('logEmit', 'vpc-smoke-test');
    assert.strictEqual(result, 'logged');
  });

  await t.test('Metrics: emit (EMF/stdout, no endpoint needed)', async () => {
    const result = await rpc('metricsEmit', 'VpcSmokeTest', 1);
    assert.strictEqual(result, 'emitted');
  });

  await t.test('Tracer: startSegment (X-Ray agent, no endpoint needed)', async () => {
    const result = await rpc('tracerRun', 'vpc-smoke-test');
    assert.strictEqual(result, 'traced');
  });
});
