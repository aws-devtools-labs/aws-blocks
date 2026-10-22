// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { trackCommand } from '../telemetry/trackCommand.js';
import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';
import { assertAwsCredentials } from './preflight-credentials.js';
import { runSync } from './run-command.js';
import { emptySandboxBuckets, runDestroyWithRetries } from './sandbox.js';

export interface DestroyOptions {
  cdkAppPath: string;
  projectRoot: string;
}

/**
 * Resolve the production app's stack names via `cdk ls` (best-effort; [] on
 * error). Mirrors the sandbox resolver but without `sandboxMode` — it drives
 * the pre-retry bucket-emptying in {@link runDestroyWithRetries}, so a failure
 * here must WARN rather than stay silent: a silent [] skips bucket-emptying,
 * the exact no-op the retry exists to avoid.
 */
function listProductionStackNames(options: DestroyOptions, cdkEnv: NodeJS.ProcessEnv): string[] {
  try {
    const out = execFileSync(
      'npx',
      ['cdk', 'ls', '--context', `projectRoot=${options.projectRoot}`],
      // Capture stderr so a genuine synth/`cdk ls` failure is logged below
      // rather than being indistinguishable from "app has zero stacks".
      { cwd: options.projectRoot, env: cdkEnv, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    const detail = (e as { stderr?: string; message?: string }).stderr || (e as Error).message;
    console.warn(`  ⚠️  could not list production stacks via 'cdk ls'; skipping bucket-emptying: ${detail}`);
    return [];
  }
}

/**
 * Production teardown behind `npm run destroy`: `cdk destroy --all --force`,
 * which deletes every top-level stack of the app (the stacks `npm run deploy`
 * creates), dependent stacks first, without a confirmation prompt. Resources
 * with a `RETAIN` removal policy are kept. Retries transient teardown failures
 * (see {@link runDestroyWithRetries}).
 */
export async function destroy(options: DestroyOptions) {
  return trackCommand('destroy', async () => {
    console.log('🗑️  Destroying production stack...');

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
    const cdkArgs = [
      'cdk', 'destroy',
      // `--all`, like the deploy (see buildCdkDeployArgs): without it CDK
      // refuses an app with more than one stack, so the destroy could never
      // succeed. It deletes every top-level stack of the app, dependent
      // stacks first; a stack deployed from this app by hand is included.
      '--all',
      '--force',
      '--context', `projectRoot=${options.projectRoot}`,
    ];

    // Reuse the sandbox path's shipped teardown-retry machinery: on a failed
    // destroy, empty the stacks' versioned S3 buckets (the autoDeleteObjects
    // Lambda never provisions on a failed CREATE, so the bucket blocks the
    // delete and the stack + its IAM roles leak) and back off before retrying.
    // The backoff also rides out a transient API Gateway control-plane throttle
    // (DeleteRestApi 429), which single-shot `cdk destroy` surfaced as a hard
    // teardown failure with no recovery.
    await runDestroyWithRetries({
      runDestroy: () => runSync('npx', cdkArgs, { stdio: 'inherit', cwd: options.projectRoot, env: cdkEnv }),
      listStacks: () => listProductionStackNames(options, cdkEnv).map((stackName) => ({ stackName })),
      emptyBuckets: emptySandboxBuckets,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      successLabel: 'Production stack',
    });
  });
}
