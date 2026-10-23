// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { trackCommand } from '../telemetry/trackCommand.js';
import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';
import { assertAwsCredentials } from './preflight-credentials.js';
import { runSync } from './run-command.js';
import {
  destroyRetryClients,
  edgeStacksBlockedByReplicas,
  emptySandboxBuckets,
  listDestroyedStacks,
  runDestroyWithRetries,
} from './sandbox.js';

export interface DestroyOptions {
  cdkAppPath: string;
  projectRoot: string;
}

/**
 * Where `destroy` has CDK write the assembly it synthesizes (`--output`),
 * relative to the project root. The retry reads the stack list from it. Not
 * the directory `sandbox:destroy` uses, so the two can run at the same time.
 */
const DESTROY_ASSEMBLY_DIR = '.blocks-sandbox/destroy.out';

/**
 * Production teardown behind `npm run destroy`: `cdk destroy --all --force`,
 * which deletes every top-level stack of the app (the stacks `npm run deploy`
 * creates; not stacks inside a CDK `Stage`), dependent stacks first, without a
 * confirmation prompt. Resources
 * with a `RETAIN` removal policy are kept. Retries transient teardown failures
 * (see {@link runDestroyWithRetries}); before a retry it empties only the S3
 * buckets the delete removes, never one the stack keeps (see
 * `listStackBucketNames` in ./sandbox.ts), reading the stacks, with their Regions, from
 * the assembly the attempt synthesized, and stops early when the Lambda@Edge
 * stack can't be deleted yet.
 */
export async function destroy(options: DestroyOptions) {
  return trackCommand('destroy', async () => {
    console.log('🗑️  Destroying production stacks...');

    // Fail fast on a missing/expired credential BEFORE entering the retry loop:
    // a credential error is deterministic, so retrying it only burns the full
    // [60s, 120s] backoff (the Telemetry E2E timeout this guards against). The
    // retry loop is for transient teardown blockers (bucket-blocked delete,
    // DeleteRestApi 429 throttle, ENI detach), never auth.
    await assertAwsCredentials({ command: 'destroy', projectRoot: options.projectRoot });

    const cdkEnv = {
      ...process.env,
      NODE_OPTIONS: '--conditions=cdk',
      ...getCdkTelemetryEnv('production'),
    };
    // The destroy synthesizes into this directory; the retry reads the stacks
    // it selected from there. Cleared first so a failed synth can't leave an
    // earlier run's stack list behind.
    const assemblyDir = join(options.projectRoot, DESTROY_ASSEMBLY_DIR);
    rmSync(assemblyDir, { recursive: true, force: true });
    const cdkArgs = [
      'cdk', 'destroy',
      // `--all`, like the deploy (see buildCdkDeployArgs): without it CDK
      // refuses an app with more than one stack, so the destroy could never
      // succeed. It deletes every top-level stack of the app, dependent
      // stacks first; a stack deployed from this app by hand is included.
      '--all',
      '--force',
      '--output', DESTROY_ASSEMBLY_DIR,
      '--context', `projectRoot=${options.projectRoot}`,
    ];

    // Reuse the sandbox path's shipped teardown-retry machinery: on a failed
    // destroy, empty the stacks' versioned S3 buckets (the autoDeleteObjects
    // Lambda never provisions on a failed CREATE, so the bucket blocks the
    // delete and the stack + its IAM roles leak) and back off before retrying.
    // The backoff also rides out a transient API Gateway control-plane throttle
    // (DeleteRestApi 429), which single-shot `cdk destroy` surfaced as a hard
    // teardown failure with no recovery.
    const clients = await destroyRetryClients(options.projectRoot);
    await runDestroyWithRetries({
      runDestroy: () => runSync('npx', cdkArgs, { stdio: 'inherit', cwd: options.projectRoot, env: cdkEnv }),
      listStacks: () => listDestroyedStacks(assemblyDir),
      emptyBuckets: (stacks) => emptySandboxBuckets(stacks, clients),
      edgeReplicaBlocked: (stacks, since) => edgeStacksBlockedByReplicas(stacks, since, clients.cfnFor),
      rerunCommand: 'npm run destroy',
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      successLabel: 'Production stacks',
    });
    rmSync(assemblyDir, { recursive: true, force: true });
  });
}
