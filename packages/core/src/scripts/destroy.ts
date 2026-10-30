// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { trackCommand } from '../telemetry/trackCommand.js';
import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';
import { assertAwsCredentials } from './preflight-credentials.js';
import { createCdkOutput } from './cdk-output.js';
import { log } from './log.js';
import { type DestroyRetryDeps, destroyWasThrottled, emptySandboxBuckets, runDestroyWithRetries } from './sandbox.js';

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
    log.warn(`  ⚠️  could not list production stacks via 'cdk ls'; skipping bucket-emptying: ${detail}`);
    return [];
  }
}

export async function destroy(options: DestroyOptions) {
  return trackCommand('destroy', async () => {
    log.progress('🗑️  Destroying production stack...');

    // Fail fast on a missing/expired credential BEFORE entering the retry loop:
    // a credential error is deterministic, so retrying it only burns the full
    // [60s, 120s] backoff (the Telemetry E2E timeout this guards against). The
    // retry loop is for transient teardown blockers (bucket-blocked delete,
    // DeleteRestApi 429 throttle, ENI detach), never auth.
    await assertAwsCredentials({ command: 'destroy', projectRoot: options.projectRoot, accountDetails: false });

    const cdkEnv = {
      ...process.env,
      NODE_OPTIONS: '--conditions=cdk',
      ...getCdkTelemetryEnv('production'),
    };
    // Reuse the sandbox path's shipped teardown-retry machinery: on a failed
    // destroy, empty the stacks' versioned S3 buckets (the autoDeleteObjects
    // Lambda never provisions on a failed CREATE, so the bucket blocks the
    // delete and the stack + its IAM roles leak) and back off before retrying.
    // The backoff also rides out a transient API Gateway control-plane throttle
    // (DeleteRestApi 429), which single-shot `cdk destroy` surfaced as a hard
    // teardown failure with no recovery. A failure whose stack events show such
    // a throttle gets a longer, jittered backoff (see runDestroyWithRetries).
    await runDestroyWithRetries(productionDestroyDeps(options, cdkEnv));
  });
}

/**
 * The {@link runDestroyWithRetries} dependencies the production `destroy`
 * runs with. A separate function so a test can pin the wiring (throttle
 * detection, bucket emptying) without spawning cdk.
 */
export function productionDestroyDeps(options: DestroyOptions, cdkEnv: NodeJS.ProcessEnv): DestroyRetryDeps {
  const cdkArgs = [
    'cdk', 'destroy',
    '--force',
    '--context', `projectRoot=${options.projectRoot}`,
  ];
  // At BLOCKS_LOG_LEVEL=quiet|normal the CDK stream is condensed and retained;
  // the retry loop prints it once the destroy finally fails.
  const cdkOutput = createCdkOutput({ label: 'cdk destroy', verb: 'destroy' });
  return {
    runDestroy: () => cdkOutput.run('npx', cdkArgs, { cwd: options.projectRoot, env: cdkEnv }),
    printRetainedOutput: () => cdkOutput.printRetained(),
    listStacks: () => listProductionStackNames(options, cdkEnv).map((stackName) => ({ stackName })),
    emptyBuckets: emptySandboxBuckets,
    isThrottled: destroyWasThrottled,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    successLabel: 'Production stack',
  };
}
