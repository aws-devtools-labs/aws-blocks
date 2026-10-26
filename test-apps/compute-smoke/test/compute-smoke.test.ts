// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compute E2E — one deployment of the compute app, every compute scenario.
 *
 * The harness deploys the app behind this leg's front door
 * (`COMPUTE_API_FRONT_DOOR`, see aws-blocks/index.cdk.ts), waits until the API
 * answers through it, and runs each scenario module against the same stack, the
 * way `comprehensive`'s e2e.test.ts does:
 * - container-jobs.test.ts — container-backed AsyncJobs in the VPC
 * - api-namespace-compute.test.ts — an API namespace on its own serverless compute
 *
 * A new scenario is a new module registered below; a module that only applies
 * to some front doors skips the others.
 *
 * Local mode can't exercise a real container or separate functions, so it skips
 * (like vpc-smoke) — the deployed run is the meaningful proof.
 */

import { after, before, describe } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { apiNamespaceComputeTests } from './api-namespace-compute.test.js';
import { containerJobTests } from './container-jobs.test.js';
import { type ComputeTestContext, FRONT_DOORS, type FrontDoor, rpcCall } from './context.js';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const isDeployed = ENV === 'sandbox' || ENV === 'production';
const __dirname = dirname(fileURLToPath(import.meta.url));
const backendPath = join(__dirname, '..', 'aws-blocks', 'index.cdk.ts');
const outputsPath = join(__dirname, '..', '.blocks-sandbox', 'outputs.json');

// Same default and values as index.cdk.ts, which reads the same variable at synth.
const frontDoor = (process.env.COMPUTE_API_FRONT_DOOR ?? 'cloudfront') as FrontDoor;
if (!FRONT_DOORS.includes(frontDoor)) throw new Error(`Unknown COMPUTE_API_FRONT_DOOR '${frontDoor}'`);

let apiUrl: string | undefined;
const ctx: ComputeTestContext = {
  frontDoor,
  apiUrl() {
    if (!apiUrl) throw new Error('The stack is not deployed yet');
    return apiUrl;
  },
};

/**
 * A new CloudFront distribution reports CREATE_COMPLETE before its domain
 * resolves at the edge, and a failed lookup is cached negatively — poll until the
 * API answers. Any JSON-RPC reply, even an error, means the front door is
 * reachable, so only transport and HTTP failures are retried. Under 'apigateway'
 * the first call answers.
 */
async function waitForFrontDoor(budgetMs = 300_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await rpcCall(ctx.apiUrl(), 'api.whereAmI');
      return;
    } catch (error) {
      lastError = error;
      await sleep(5_000);
    }
  }
  throw new Error(`Front door not reachable within ${budgetMs / 1000}s: ${String(lastError)}`);
}

describe(`Compute (${frontDoor} front door)`, { skip: !isDeployed && 'Compute tests require deployment — skipping in local mode.' }, () => {
  before(async () => {
    console.log(`🚀 Deploying ${ENV} (apiFrontDoor: ${frontDoor})...\n`);
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
    await waitForFrontDoor();
  });

  after(async () => {
    if (!process.env.BLOCKS_SANDBOX_KEEP) {
      console.log(`\n🗑️  Destroying ${ENV} stack...`);
      try {
        execFileSync('npx', ['tsx', 'test/sandbox-destroy.ts', backendPath], {
          cwd: join(__dirname, '..'),
          stdio: 'inherit',
          env: { ...process.env, NODE_OPTIONS: '' },
        });
        console.log('✅ Stack destroyed');
      } catch (error) {
        // In CI a failed teardown fails the run (the job's last step retries the
        // destroy); a stack left behind would keep its endpoints in the shared VPC.
        if (process.env.CI) throw error;
        console.log('⚠️  Stack destroy failed — run test/sandbox-destroy.ts again, or the scheduled cleanup removes it');
      }
    }
  });

  apiNamespaceComputeTests(ctx);
  containerJobTests(ctx);
});
